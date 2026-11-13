// 与客户端无关的「上游代理」探测。
//
// 之前只有一个假设：用户装的是 Clash Verge Rev，于是去它的目录里
// 读 mixed-port。用户用 Surge / Stash / ClashX / mihomo-party，或者
// 只是开了系统代理时，这条路直接走空，工具看起来「坏的」。
//
// 这里改成三层信号，按可靠性排序，并且**每个候选都真的按代理协议测一次**——
// 端口在监听不等于它是代理，更不等于它能出网：
//
//   1. mihomo REST API 报出来的 mixed-port（Verge / ClashX Meta / 原生 mihomo）
//   2. macOS 系统代理（scutil --proxy）：所有正经客户端都会设，前端无关
//   3. 本机监听端口 + 已知代理进程名兜底，再按协议验证
//
// 只有「说出代理协议」的端口才算候选。这样既支持 mixed 端口（HTTP + SOCKS5），
// 也支持只有 HTTP 的 Surge/Stash，和只有 SOCKS5 的 sing-box / v2ray。

import net from "node:net";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { systemProxyState } from "./discover.js";
import { dataDir } from "./paths.js";

const exec = promisify(execFile);

// 已知代理客户端：进程名 -> 展示名
const KNOWN_PROCESSES = [
  { re: /clash-verge|verge-mihomo/i, label: "Clash Verge Rev" },
  // 注意别加裸的 "party"：party.mihomo.helper、searchpartyd 都会命中
  { re: /mihomo-party|Mihomo Party/i, label: "mihomo-party" },
  { re: /clashx/i, label: "ClashX" },
  { re: /mihomo/i, label: "mihomo" },
  { re: /sing-box/i, label: "sing-box" },
  { re: /v2ray|xray/i, label: "v2ray" },
  { re: /surge/i, label: "Surge" },
  { re: /stash/i, label: "Stash" },
  { re: /quantumult/i, label: "Quantumult" },
  { re: /loon/i, label: "Loon" },
  // wmsxwd 的内核进程叫 AtlasCore，配置是 GUI 通过 stdin 喂进去的，
  // 磁盘上只有一份状态缓存 —— 认不出进程名就没法告诉用户「你现在用的是谁」。
  { re: /atlascore|wmsxwd/i, label: "wmsxwd" },
  { re: /privoxy|squid|tinyproxy/i, label: "本地代理" },
];

export function labelForProcess(command) {
  const hit = KNOWN_PROCESSES.find((k) => k.re.test(command));
  return hit ? hit.label : null;
}

/**
 * 当前正在用的客户端是谁。
 *
 * 判据只有一个：系统代理指向的那个端口，是哪个进程在监听。
 * 「装在机器上」不等于「正在用」——很多人机器上同时留着好几个客户端，
 * 只看安装目录会一直报旧的那个，用户看着就别扭。
 */
export async function detectActiveClient() {
  try {
    const sys = await systemProxyState();
    if (!sys?.httpEnabled || !sys.port) return null;
    const rows = await listeningPorts();
    const row = rows.find((r) => r.port === Number(sys.port));
    if (!row) return null;
    const label = labelForProcess(row.process);
    if (!label) return null;
    let id = null;
    if (/wmsxwd|atlascore/i.test(row.process)) id = "wmsxwd";
    else if (/mihomo-party/i.test(row.process)) id = "generic-mihomo";
    else if (/clash-verge|verge-mihomo/i.test(row.process)) id = "clash-verge-rev";
    return { id, label, port: Number(sys.port), process: row.process };
  } catch {
    return null;
  }
}

/**
 * 从运行中的进程判断用户用的是哪个客户端。
 * 这一步不需要任何 API：Surge / Stash 没有 mihomo 那样的 REST 接口，
 * 但进程名一说就知道，界面至少能显示「认出来了，只是我改不了它的配置」。
 */
export async function detectClient() {
  try {
    const { stdout } = await exec("ps", ["-Ao", "pid=,command="], {
      timeout: 8000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const lines = stdout.split("\n").filter(Boolean);
    // 优先认真正的 GUI 客户端（/Applications/xxx.app），而不是 helper 或内核进程：
    // Clash Verge 在跑的时候，它的 helper 和 party 的 helper 可能同时存在。
    const gui = lines.find(
      (line) => /\/Applications\/.+\.app\//.test(line) && labelForProcess(line),
    );
    const hit = gui ?? lines.find((line) => labelForProcess(line));
    if (hit) return { label: labelForProcess(hit), command: hit.trim() };
  } catch {
    // 读不到进程就当作未知
  }
  return null;
}

/**
 * 解析 `lsof -nP -iTCP -sTCP:LISTEN` 的输出。
 *
 * 端口在监听不等于它是代理，所以这里只负责把「可能是代理的监听端口」捞出来，
 * 真假交给协议实测（probeProtocols）判断。
 *
 * 回环地址（127.0.0.1 / ::1）一律保留；通配绑定（*、0.0.0.0）也保留 ——
 * wmsxwd 的 AtlasCore 就是 `*:6478`，之前被当成「局域网端口」丢掉，
 * 结果只能靠系统代理那条路偶然认出来，用户一关系统代理就完全找不到它了。
 * 通配绑定一律按 127.0.0.1 去连：IPv6 通配在 macOS 上同时接受 IPv4 连接。
 */
export function parseListening(output, { commands = new Map() } = {}) {
  const rows = [];
  for (const line of String(output).split("\n").slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 9) continue;
    const command = cols[0];
    const pid = Number(cols[1]);
    // lsof 有两种排布：NAME 在最后一列，或者 NAME 后面还跟一个 "(LISTEN)"。
    const name = /^\(LISTEN\)$/i.test(cols[cols.length - 1])
      ? cols[cols.length - 2]
      : cols[cols.length - 1];
    const m = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(name);
    if (!m) continue;
    const host = m[1].replace(/^\[|\]$/g, "");
    const port = Number(m[2]);
    if (!Number.isFinite(port) || port <= 0) continue;
    const wildcard = host === "*" || host === "0.0.0.0" || host === "::";
    if (!wildcard && !(host === "127.0.0.1" || host === "::1" || host === "localhost")) continue;
    rows.push({
      host: "127.0.0.1",
      port,
      pid: Number.isFinite(pid) ? pid : null,
      process: commands.get(pid) ?? command,
      wildcard,
      bound: host,
    });
  }
  return rows;
}

export async function listeningPorts() {
  try {
    const [{ stdout }, ps] = await Promise.all([
      exec("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], {
        timeout: 8000,
        maxBuffer: 8 * 1024 * 1024,
      }),
      exec("ps", ["-Ao", "pid=,command="], { timeout: 8000, maxBuffer: 16 * 1024 * 1024 }),
    ]);
    const commands = new Map();
    for (const line of ps.stdout.split("\n")) {
      const idx = line.trim().indexOf(" ");
      if (idx === -1) continue;
      const pid = Number(line.trim().slice(0, idx));
      if (Number.isFinite(pid)) commands.set(pid, line.trim().slice(idx + 1));
    }
    return parseListening(stdout, { commands });
  } catch {
    return [];
  }
}

/**
 * 系统代理：macOS 上最接近「前端无关」的信号。
 * HTTPEnable 关掉但 SOCKSEnable 开着也要能认出来。
 */
export async function systemProxyCandidates() {
  const sys = await systemProxyState();
  if (!sys) return [];
  const out = [];
  const host = sys.host && sys.host !== "" ? sys.host : "127.0.0.1";
  if (sys.httpEnabled && sys.port) {
    out.push({
      host: host === "127.0.0.1" || host === "localhost" ? "127.0.0.1" : host,
      port: Number(sys.port),
      source: "system-proxy",
      label: "系统代理",
    });
  }
  return out;
}

/** 探测一个端口说的是哪种代理协议；返回 [] 表示不是代理 */
export async function probeProtocols(host, port, timeoutMs = 1200) {
  const [socks5, http] = await Promise.all([
    probeSocks5(host, port, timeoutMs),
    probeHttp(host, port, timeoutMs),
  ]);
  return [socks5 ? "socks5" : null, http ? "http" : null].filter(Boolean);
}

export function probeSocks5(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    // 硬超时：光靠 socket 的空闲超时不够。有些服务（ssh 端口）会先吐一段
    // 自己的 banner，之后就一直安静地挂着 —— 那时 socket 不算「空闲」，
    // 探测就会永远挂住，整个发现流程卡死。
    const timer = setTimeout(() => done(false), timeoutMs);
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("error", () => done(false));
    socket.once("connect", () => socket.write(Buffer.from([5, 2, 0, 2])));
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 2) return;
      // 回的不是 SOCKS5 握手（比如 ssh banner）—— 这不是 SOCKS 端口。
      if (buf[0] !== 5) return done(false);
      done(buf[0] === 5 && (buf[1] === 0 || buf[1] === 2));
    });
  });
}

export function probeHttp(host, port, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const timer = setTimeout(() => done(false), timeoutMs);
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("error", () => done(false));
    socket.once("connect", () => {
      // 目标故意选一个必定连不上的地址：我们要的是「它像个 HTTP 代理那样回话」，
      // 而不是真的出网成功。
      socket.write(
        "CONNECT 127.0.0.1:9 HTTP/1.1\r\nHost: 127.0.0.1:9\r\nProxy-Connection: close\r\n\r\n",
      );
    });
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("latin1");
      if (buf.length > 4096) return done(false);
      const line = buf.split("\r\n")[0];
      if (!line) return;
      const m = /^HTTP\/1\.[01] (\d{3})/.exec(line);
      // 回了一段不是 HTTP 的东西（SSH banner、TLS 握手），就是别的服务。
      if (line.length >= 4 && !line.startsWith("HTTP/")) return done(false);
      if (!m) return;
      // 代理对一条无法完成的 CONNECT 会回 200 / 407 / 502 之类；
      // 普通 web 服务器收到 CONNECT 通常回 400 / 404 / 405 / 501。
      // 不区分的话，Clash Verge GUI 自己的本地 web 端口（回 404）也会被认成代理。
      //
      // 403 不算：macOS 的 AirPlay 接收端（7000 / 5000）对任何 CONNECT 都回
      // 403 Forbidden，会被误认成代理 —— 这两个端口是系统自带的，谁都躲不掉。
      done(PROXY_CONNECT_STATUSES.has(Number(m[1])), false);
    });
  });
}

const PROXY_CONNECT_STATUSES = new Set([200, 407, 502, 503, 504]);

/** 用真实目标验证这个上游能不能出网；失败只代表「现在出不去」，不代表不是代理 */
export async function verifyUpstream(upstream, { target = "github.com", timeoutMs = 6000 } = {}) {
  if (!upstream) return { ok: false, detail: "没有可用的上游代理" };
  if (upstream.protocols?.includes("http")) {
    return verifyHttpProxy(upstream, target, timeoutMs);
  }
  if (upstream.protocols?.includes("socks5")) {
    return verifySocks5Proxy(upstream, target, 443, timeoutMs);
  }
  return { ok: false, detail: "上游不支持 http / socks5" };
}

function verifyHttpProxy({ host, port }, target, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const done = (ok, detail) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, detail });
    };
    socket.setTimeout(timeoutMs, () => done(false, `${host}:${port} 无响应`));
    socket.once("error", (err) => done(false, err.code ?? err.message));
    socket.once("connect", () => {
      socket.write(
        `CONNECT ${target}:443 HTTP/1.1\r\nHost: ${target}:443\r\nUser-Agent: tunless\r\n\r\n`,
      );
    });
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("latin1");
      if (buf.length > 4096) return done(false, "响应过长");
      const line = buf.split("\r\n")[0];
      const m = line ? /^HTTP\/1\.[01] (\d{3})/.exec(line) : null;
      if (!m) return;
      const code = Number(m[1]);
      done(code === 200, code === 200 ? `CONNECT ${target}:443 成功` : `代理返回 HTTP ${code}`);
    });
  });
}

function verifySocks5Proxy({ host, port }, target, targetPort, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const done = (ok, detail) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, detail });
    };
    socket.setTimeout(timeoutMs, () => done(false, `${host}:${port} 无响应`));
    socket.once("error", (err) => done(false, err.code ?? err.message));
    let stage = 0;
    let buf = Buffer.alloc(0);
    socket.once("connect", () => socket.write(Buffer.from([5, 1, 0])));
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (stage === 0) {
        if (buf.length < 2) return;
        if (buf[0] !== 5 || buf[1] !== 0) return done(false, "上游拒绝了 SOCKS5 握手");
        buf = buf.subarray(2);
        stage = 1;
        const name = Buffer.from(target, "utf8");
        const req = Buffer.concat([
          Buffer.from([5, 1, 0, 3, name.length]),
          name,
          (() => {
            const p = Buffer.alloc(2);
            p.writeUInt16BE(targetPort);
            return p;
          })(),
        ]);
        socket.write(req);
      }
      if (stage === 1) {
        if (buf.length < 4) return;
        const code = buf[1];
        done(code === 0, code === 0 ? `CONNECT ${target}:${targetPort} 成功` : `SOCKS5 错误码 ${code}`);
      }
    });
  });
}

/**
 * 汇总所有候选上游，并按「真的能用」排序。
 *
 * @param {object} opts
 * @param {number|null} opts.mixedPort 已经从 mihomo API 读到的混合端口
 * @param {number[]} opts.excludePorts 不要把 tunless 自己排进去
 */
export async function discoverUpstream({
  mixedPort = null,
  excludePorts = [8899, 8898],
  timeoutMs = 1200,
  probe = true,
} = {}) {
  const raw = [];
  if (mixedPort) {
    raw.push({
      host: "127.0.0.1",
      port: Number(mixedPort),
      source: "core-api",
      label: "代理内核（REST API）",
      priority: 0,
    });
  }
  for (const c of await systemProxyCandidates()) {
    raw.push({ ...c, priority: 1 });
  }
  for (const row of await listeningPorts()) {
    const label = labelForProcess(row.process);
    raw.push({
      ...row,
      source: label ? "known-process" : "listening",
      label: label ?? row.process,
      priority: label ? 2 : 3,
    });
  }

  const seen = new Set();
  const ordered = [];
  for (const c of raw.sort((a, b) => a.priority - b.priority)) {
    const key = `${c.host}:${c.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (excludePorts.includes(Number(c.port))) continue;
    ordered.push(c);
  }

  // 已知客户端 / 系统代理这类「高可信」候选先并发探；只有它们全都不像代理时，
  // 才去扫剩下所有监听端口 —— 否则每个端口都等一次超时，界面会卡十几秒。
  const highPriority = ordered.filter((c) => c.priority <= 2);
  const lowPriority = ordered.filter((c) => c.priority > 2);

  const candidates = [];
  const probeBatch = async (batch) => {
    const results = new Array(batch.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < batch.length) {
        const index = cursor;
        cursor += 1;
        const c = batch[index];
        const protocols = probe ? await probeProtocols(c.host, c.port, timeoutMs) : [];
        results[index] = { ...c, protocols, isProxy: protocols.length > 0 };
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, batch.length) }, worker));
    return results;
  };

  const high = await probeBatch(highPriority);
  candidates.push(...high);
  if (!high.some((c) => c.isProxy) && lowPriority.length) {
    candidates.push(...(await probeBatch(lowPriority)));
  }

  const usable = candidates.filter((c) => c.isProxy);
  const chosen = usable[0] ?? null;
  return {
    upstream: chosen
      ? { host: chosen.host, port: chosen.port, protocols: chosen.protocols }
      : null,
    chosen,
    candidates,
  };
}

/** 把探测结果压成一句人话，用来解释「我为什么选了这个端口」 */
export function describeCandidate(c) {
  const proto = c.protocols?.length ? c.protocols.join("+") : "不是代理";
  return `${c.host}:${c.port} ${c.label ?? ""}（${proto}）`.trim();
}

/**
 * 判断「你钉住的上游」是不是已经过期。
 *
 * 真实踩过的坑：用户把客户端从 Clash Verge 换成 wmsxwd。旧客户端是 root
 * 常驻服务，进程还在后台、端口还在监听 —— 于是「钉住的值」依然是活的，
 * 但流量其实被送回了旧客户端。用户以为已经切换，其实一点没切。
 *
 * 判据：系统代理开着、指向另一个端口，而且那个端口确实是代理。
 * 这时候以系统代理为准 —— 它代表「用户当前正在用的客户端」。
 */
export async function detectPinnedDrift({
  pinned,
  excludePorts = [8899, 8898],
  timeoutMs = 1200,
  systemProxy = undefined,
  probe = null,
} = {}) {
  if (!pinned) return { stale: false };
  const sys = systemProxy ?? (await systemProxyCandidates());
  const other = sys.find(
    (c) =>
      Number(c.port) !== Number(pinned.port) && !excludePorts.includes(Number(c.port)),
  );
  if (!other) return { stale: false };

  const protocols = probe
    ? await probe(other.host, other.port, timeoutMs)
    : await probeProtocols(other.host, other.port, timeoutMs);
  if (!protocols.length) return { stale: false };

  // 新版钉住值会记下「当时系统代理指向哪儿」。用户可能就是故意钉一个
  // 跟系统代理不一样的端口（比如公司专线），这种情况必须尊重用户选择。
  if (pinned.systemProxyPort !== null && pinned.systemProxyPort !== undefined) {
    if (Number(pinned.systemProxyPort) === Number(other.port)) {
      // 钉住时系统代理就已经是这个端口 —— 用户是故意的，不算漂移。
      return { stale: false };
    }
  }

  const row = (await listeningPorts()).find((r) => r.port === Number(other.port));
  const label = row ? labelForProcess(row.process) : null;
  return {
    stale: true,
    replacement: {
      host: other.host,
      port: Number(other.port),
      protocols,
      source: "system-proxy",
      label: label ?? "系统代理",
    },
    reason:
      `你固定的 ${pinned.host}:${pinned.port} 还是旧客户端在用，` +
      `系统代理已经切到 ${other.host}:${other.port}${label ? `（${label}）` : ""}`,
  };
}

/**
 * 找出本机的 mihomo REST 控制器端口。
 *
 * wmsxwd 这类客户端把配置放在运行时（GUI 通过 stdin 注入），磁盘上的
 * config.yaml 只是一份状态缓存，里面写的 external-controller 根本没在监听。
 * 只能靠「哪个监听端口会用 mihomo 的口吻回话」反推：
 * 正确 secret → 200 {"version":...}；secret 不对 → 401 Unauthorized。
 */
export async function detectControllerPorts({ timeoutMs = 900 } = {}) {
  const rows = await listeningPorts();
  const hits = [];
  await Promise.all(
    rows.map(async (row) => {
      const hit = await probeVersionEndpoint(row.host, row.port, timeoutMs);
      if (hit) hits.push({ ...row, ...hit });
    }),
  );
  return hits.sort((a, b) => a.port - b.port);
}

function probeVersionEndpoint(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.request(
      { host, port, path: "/version", method: "GET", timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          // 401 + Unauthorized：mihomo 认出来了，只是缺 secret；
          // 200 里带 version 字段：secret 正确。
          // 必须贴着 mihomo 的原样回话（{"message":"Unauthorized"}）来判断 ——
          // Electron 之类的前端口也会回 401 unauthorized，认错了会把一堆
          // 无关端口当成内核控制器。
          const unauthorized =
            res.statusCode === 401 && /"message"\s*:\s*"Unauthorized"/i.test(text);
          let ok = false;
          if (res.statusCode === 200) {
            try {
              ok = typeof JSON.parse(text)?.version === "string";
            } catch {
              ok = false;
            }
          }
          if (!unauthorized && !ok) return resolve(null);
          resolve({
            status: res.statusCode,
            needsSecret: unauthorized,
            version: ok ? text.slice(0, 120) : null,
          });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

// ---- 用户手动指定的上游 ----
//
// 自动探测会失败：客户端可能绑在非回环地址、可能只在 TUN 下开放端口、
// 也可能是我们还不认识的客户端。这时候必须让用户能直接写一句
// 「我的代理在 127.0.0.1:6152」，而且这个选择要能跨重启保留 ——
// 常驻服务是 launchd 拉起来的，拿不到当前终端的参数。

export function upstreamFile() {
  return path.join(dataDir(), "upstream.json");
}

export function loadPinnedUpstream() {
  try {
    const raw = fs.readFileSync(upstreamFile(), "utf8");
    const data = JSON.parse(raw);
    const port = Number(data.port);
    if (!Number.isFinite(port) || port <= 0) return null;
    return {
      host: data.host || "127.0.0.1",
      port,
      label: "手动指定",
      pinned: true,
      // 钉住那一刻的系统代理端口，用来判断「用户是不是换了客户端」。
      // 老版本没有这个字段，一律当作「可能是过期钉住」。
      systemProxyPort: Number.isFinite(Number(data.systemProxyPort))
        ? Number(data.systemProxyPort)
        : null,
    };
  } catch {
    return null;
  }
}

export function savePinnedUpstream({ host = "127.0.0.1", port, systemProxyPort = null }) {
  fs.mkdirSync(dataDir(), { recursive: true });
  fs.writeFileSync(
    upstreamFile(),
    `${JSON.stringify(
      { host, port: Number(port), systemProxyPort: systemProxyPort === null ? null : Number(systemProxyPort) },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return upstreamFile();
}

export function clearPinnedUpstream() {
  try {
    fs.unlinkSync(upstreamFile());
    return true;
  } catch {
    return false;
  }
}

/** 解析 `127.0.0.1:7897` / `7897` 这类手写输入 */
export function parseUpstream(value, fallbackHost = "127.0.0.1") {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const idx = raw.lastIndexOf(":");
  if (idx === -1) {
    const port = Number(raw);
    return Number.isFinite(port) && port > 0 ? { host: fallbackHost, port } : null;
  }
  const port = Number(raw.slice(idx + 1));
  if (!Number.isFinite(port) || port <= 0) return null;
  return { host: raw.slice(0, idx) || fallbackHost, port };
}
