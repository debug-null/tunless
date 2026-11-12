import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { probeApi } from "./core/api.js";
import { discoverAll, systemProxyState } from "./core/discover.js";
import { classifyDomain } from "./core/dns.js";
import { scanAll } from "./core/scan.js";
import { inspectProcesses, proxyAdvice } from "./core/proc.js";
import {
  partitionByKind,
  mergeHosts,
  mergeHostsValidated,
  buildDnsSection,
  renderDiff,
} from "./core/plan.js";
import { dumpYaml } from "./core/yaml.js";
import { HttpProxyServer, Socks5Server } from "./core/relay.js";
import {
  installService,
  uninstallService,
  serviceStatus,
  readServiceLog,
} from "./core/launchd.js";
import { VergeAdapter } from "./adapters/verge.js";
import { GenericAdapter } from "./adapters/generic.js";

const DEFAULT_INTERNAL_DNS = "10.249.150.130";
const exec = promisify(execFile);

// TUI 调用时静默输出，避免刷屏破坏界面。
let quiet = false;
export function setQuiet(value) {
  quiet = Boolean(value);
}
function say(text) {
  if (!quiet) console.log(text);
}

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

const color = process.stdout.isTTY && !process.env.NO_COLOR;
function paint(code, text) {
  return color ? `${code}${text}${C.reset}` : text;
}
const ok = (t) => paint(C.green + C.bold, `✔ ${t}`);
const warn = (t) => paint(C.yellow + C.bold, `⚠ ${t}`);
const bad = (t) => paint(C.red + C.bold, `✖ ${t}`);
const info = (t) => paint(C.cyan, `• ${t}`);
const head = (t) => paint(C.bold, t);
const dim = (t) => paint(C.dim, t);

export function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        args.flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          args.flags[a.slice(2)] = next;
          i += 1;
        } else {
          args.flags[a.slice(2)] = true;
        }
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function resolveAdapter(frontend) {
  if (frontend.id === "clash-verge-rev") return new VergeAdapter(frontend);
  return new GenericAdapter(frontend);
}

async function pickFrontend(flags) {
  const frontends = discoverAll();
  const explicit = flags.frontend;
  if (explicit) {
    const found = frontends.find((f) => f.id === explicit || f.label === explicit);
    if (!found) throw new Error(`未知客户端：${explicit}`);
    return found;
  }
  for (const f of frontends) {
    if (f.id === "clash-verge-rev" && fs.existsSync(f.home)) return f;
  }
  return frontends[frontends.length - 1];
}

async function connect(frontend) {
  return probeApi(frontend.apiCandidates);
}

function backendDir() {
  return path.join(os.homedir(), ".netfix");
}

function backupDir() {
  return path.join(backendDir(), "backups", new Date().toISOString().replace(/[:.]/g, "-"));
}

function validatedMerger(internalDns, extraSuffixes = []) {
  return (hosts) =>
    mergeHostsValidated(hosts, {
      classify: (name) => classifyDomain(name, internalDns),
      extraSuffixes,
    });
}

async function probeDomains(hosts, internalDns, concurrency = 8) {
  const results = [];
  const queue = [...hosts];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const host = queue.shift();
      results.push(await classifyDomain(host, internalDns));
    }
  });
  await Promise.all(workers);
  return results;
}

export async function cmdScan(args) {
  const internalDns = args.flags["internal-dns"] || DEFAULT_INTERNAL_DNS;
  const repoRoots = args.flags.repos
    ? String(args.flags.repos).split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const includeChrome = args.flags["no-chrome"] !== true;

  const scanned = await scanAll({ repoRoots, includeChrome });
  const hosts = scanned.hosts.map((h) => h.host);

  say(head(`\n共扫描到 ${hosts.length} 个候选域名`));
  say(dim(`  来源：${scanned.sources.join("、") || "无"}`));
  for (const note of scanned.notes) say(`  ${warn(note)}`);

  const results = await probeDomains(hosts, internalDns);
  const { internal, fake, publicHosts, unresolved } = partitionByKind(results);

  say(head(`\n${head("内网域名")}（解析到私网地址 — ${internal.length}）`));
  for (const r of internal.sort((a, b) => a.name.localeCompare(b.name))) {
    say(`  ${ok(r.name.padEnd(50))} ${dim(r.ips.join(", "))}`);
  }
  say(head(`\n${head("假 IP 域名")}（需要加入过滤 — ${fake.length}）`));
  for (const r of fake.slice(0, 20)) {
    say(`  ${warn(r.name.padEnd(50))} ${dim(r.ips.join(", "))}`);
  }
  say(head(`\n${head("公网域名")}（${publicHosts.length}）— 仅显示前几个`));
  say(dim(`  ${publicHosts.slice(0, 10).map((r) => r.name).join(", ")}`));
  if (unresolved.length) {
    say(head(`\n${head("无法解析")}（${unresolved.length}）`));
    for (const r of unresolved.slice(0, 10)) say(`  ${dim(r.name)} — ${r.error}`);
  }
  say();
  return 0;
}

export async function cmdDoctor(args) {
  const internalDns = args.flags["internal-dns"] || DEFAULT_INTERNAL_DNS;
  let exitCode = 0;

  say(head("\n── 环境 ──"));
  const frontends = discoverAll();
  const frontend = await pickFrontend(args);
  say(`  ${info(`客户端：${frontend.label}`)}`);

  let api = null;
  try {
    const conn = await connect(frontend);
    api = conn.api;
    say(`  ${ok(`内核接口可达（${conn.api.descriptor}）`)}`);
    say(dim(`    版本：${conn.info.version}`));
  } catch (err) {
    exitCode = 1;
    say(`  ${bad("内核接口不可达")}`);
    for (const f of err.failures ?? []) {
      say(dim(`    ${f.candidate.socketPath ? `unix://${f.candidate.socketPath}` : `http://${f.candidate.host}:${f.candidate.port}`}: ${f.error}`));
    }
    say(dim("    请先启动代理客户端，然后重新运行 netfix doctor"));
  }

  if (api) {
    try {
      const cfg = await api.configs();
      const tun = cfg.tun?.enable;
      say(`  ${tun ? ok("TUN mode enabled") : warn("TUN mode disabled")}`);
      if (!tun) {
        say(dim("    programs that read HTTPS_PROXY/ALL_PROXY are covered by: netfix proxy"));
        say(dim("    programs that ignore the proxy entirely need TUN mode"));
      }
      const mode = cfg.mode;
      say(`  ${info(`分流模式：${mode}`)}`);
    } catch (err) {
      exitCode = 1;
      say(`  ${bad(`读取内核配置失败：${err.message}`)}`);
    }
  }

  const sysProxy = await systemProxyState();
  if (sysProxy) {
    const enabled = sysProxy.httpEnabled && sysProxy.httpsEnabled;
    say(`  ${enabled ? ok("系统代理已启用") : warn("系统代理未启用")} ${dim(`${sysProxy.host}:${sysProxy.port}`)}`);
  }

  if (frontend.id === "clash-verge-rev") {
    say(`  ${frontend.mergeFile ? ok("已找到 merge 增强文件") : warn("没有 merge 增强文件")}`);
    if (frontend.mergeFile) say(dim(`    ${frontend.mergeFile}`));
    say(`  ${frontend.tunEnabled ? ok("客户端 TUN 开关已开启") : warn("客户端 TUN 开关已关闭")}`);
  }

  say(head("\n── 程序代理能力 ──"));
  const procs = await inspectProcesses();
  if (!procs.length) {
    say(dim("  未发现相关进程"));
  }
  for (const p of procs) {
    const badge =
      p.status === "supported"
        ? ok("支持代理环境变量")
        : p.status === "unsupported"
          ? warn("不支持代理环境变量")
          : dim("代理能力未知");
    say(`  ${String(p.pid).padEnd(7)} ${p.comm.slice(0, 52).padEnd(52)} ${badge}`);
    if (p.status === "unsupported") say(dim(`      ${proxyAdvice(p)}`));
  }

  say(head("\n── 转发服务 ──"));
  say(`  ${info("netfix proxy 让工具无需 TUN 也能走代理")}`);
  say(dim("    netfix proxy            # HTTP 8899 / SOCKS5 8898"));
  say(dim("    export HTTPS_PROXY=http://127.0.0.1:8899"));

  say(head("\n── 内网域名 ──"));
  const repoRoots = args.flags.repos
    ? String(args.flags.repos).split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const scanned = await scanAll({ repoRoots, includeChrome: args.flags["no-chrome"] !== true });
  const results = await probeDomains(scanned.hosts.map((h) => h.host), internalDns);
  const { internal, fake } = partitionByKind(results);

  say(`  ${info(`${internal.length} 个内网域名解析到私网地址`)}`);
  say(`  ${info(`${fake.length} 个域名仍解析为假 IP`)}`);

  if (api) {
    const suffixes = await validatedMerger(internalDns)(internal.map((r) => r.name));
    if (suffixes.length) {
      let missing = [];
      for (const s of suffixes) {
        const res = await classifyDomain(s, internalDns);
        if (res.kind === "fake") missing.push(s);
      }
      if (missing.length) {
        exitCode = 1;
        say(`  ${bad(`${missing.length} 个后缀仍是假 IP — 请运行：netfix fix`)}`);
        for (const m of missing) say(dim(`    +.${m}`));
      } else {
        say(`  ${ok("所有内网后缀均解析到私网地址")}`);
      }
    }
  }

  say();
  return exitCode;
}


export async function collectInternalSuffixes(frontend, internalDns, { scan = true, repoRoots = [] } = {}) {
  const suffixes = new Set();

  // 1. whatever the running client already routes to the internal resolver
  try {
    const adapter = resolveAdapter(frontend);
    const dns = adapter.readCurrentDns?.() ?? {};
    for (const key of Object.keys(dns["nameserver-policy"] ?? {})) {
      const clean = String(key).replace(/^\+\./, "").replace(/^["']|["']$/g, "");
      if (clean) suffixes.add(clean);
    }
    for (const entry of dns["fake-ip-filter"] ?? []) {
      const clean = String(entry).replace(/^\+\./, "").replace(/^\*\./, "").replace(/^["']|["']$/g, "");
      if (clean && clean.includes(".")) suffixes.add(clean);
    }
  } catch {
    // no readable client config — fall back to the scan only
  }

  // 2. hosts we can observe resolving to private addresses right now
  if (scan) {
    const scanned = await scanAll({ repoRoots, includeChrome: false });
    const results = await probeDomains(scanned.hosts.map((h) => h.host), internalDns);
    const { internal } = partitionByKind(results);
    for (const suffix of await validatedMerger(internalDns)(internal.map((r) => r.name))) {
      suffixes.add(suffix);
    }
  }

  return [...suffixes].sort();
}

export async function cmdProxy(args) {
  const internalDns = args.flags["internal-dns"] || DEFAULT_INTERNAL_DNS;
  const frontend = await pickFrontend(args);
  const httpPort = Number(args.flags.port || 8899);
  const socksPort = Number(args.flags["socks-port"] ?? 8898);

  let upstream = { host: "127.0.0.1", port: frontend.mixedPort || 7897 };
  let coreVersion = null;

  if (typeof args.flags.upstream === "string") {
    const raw = args.flags.upstream.trim();
    const idx = raw.lastIndexOf(":");
    upstream = idx === -1
      ? { host: raw, port: upstream.port }
      : { host: raw.slice(0, idx), port: Number(raw.slice(idx + 1)) || upstream.port };
  }
  try {
    const conn = await connect(frontend);
    const cfg = await conn.api.configs();
    coreVersion = conn.info.version;
    if (cfg["mixed-port"]) upstream = { host: "127.0.0.1", port: Number(cfg["mixed-port"]) };
  } catch (err) {
    say(`  ${warn(`无法读取内核配置：${err.message}`)}`);
  }

  const repoRoots = args.flags.repos
    ? String(args.flags.repos).split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const suffixes = await collectInternalSuffixes(frontend, internalDns, {
    scan: args.flags["no-scan"] !== true,
    repoRoots,
  });

  say(head("\n── netfix proxy ──\n"));
  say(`  ${info(`上游内核：${upstream.host}:${upstream.port}${coreVersion ? `（mihomo ${coreVersion}）` : ""}`)}`);
  say(`  ${info(`内网域名：${suffixes.length ? suffixes.join("、") : "未检测到"}`)}`);
  say(`  ${ok(`HTTP 代理 ：http://127.0.0.1:${httpPort}`)}`);
  if (socksPort) say(`  ${ok(`SOCKS5 代理：socks5://127.0.0.1:${socksPort}`)}`);

  const noProxy = suffixes.join(",");
  say(head("\n  让工具指向它："));
  say(dim("    export HTTPS_PROXY=http://127.0.0.1:" + httpPort));
  say(dim("    export HTTP_PROXY=http://127.0.0.1:" + httpPort));
  if (socksPort) say(dim("    export ALL_PROXY=socks5://127.0.0.1:" + socksPort));
  if (noProxy) say(dim(`    export NO_PROXY=${noProxy}`));
  say(dim("    （小写变量名同样有效）"));

  if (args.flags["print-env"] === true) {
    say();
    return 0;
  }

  const log = (line) => say(dim(`    ${line}`));
  const httpServer = new HttpProxyServer({
    port: httpPort,
    upstream,
    internalDns,
    internalSuffixes: suffixes,
    log,
  });
  await httpServer.start();

  let socksServer = null;
  if (socksPort) {
    socksServer = new Socks5Server({
      port: socksPort,
      upstream,
      internalDns,
      internalSuffixes: suffixes,
      log,
    });
    await socksServer.start();
  }

  say(head("\n  正在监听 — 按 Ctrl+C 停止。\n"));

  const shutdown = async () => {
    say(dim("\n  正在停止…"));
    await httpServer.stop();
    if (socksServer) await socksServer.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => {});
  return 0;
}



export async function cmdLaunch(args) {
  const app = args.flags.app || args._[1] || "Antigravity";
  const httpPort = Number(args.flags.port || 8899);
  const socksPort = Number(args.flags["socks-port"] ?? 8898);
  const noProxy = args.flags["no-proxy"] || "";

  // Resolve the internal domains the same way the sidecar does, so the
  // NO_PROXY list stays consistent with the routing rules.
  const internalDns = args.flags["internal-dns"] || DEFAULT_INTERNAL_DNS;
  const frontend = await pickFrontend(args);
  const repoRoots = args.flags.repos
    ? String(args.flags.repos).split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const suffixes = await collectInternalSuffixes(frontend, internalDns, {
    scan: args.flags["no-scan"] !== true,
    repoRoots,
  });
  const noProxyList = ["127.0.0.1", "localhost", "::1", ".local", ...suffixes]
    .filter(Boolean)
    .join(",");

  const env = {
    HTTPS_PROXY: `http://127.0.0.1:${httpPort}`,
    HTTP_PROXY: `http://127.0.0.1:${httpPort}`,
    https_proxy: `http://127.0.0.1:${httpPort}`,
    http_proxy: `http://127.0.0.1:${httpPort}`,
    NO_PROXY: noProxyList,
    no_proxy: noProxyList,
  };
  if (socksPort) {
    env.ALL_PROXY = `socks5://127.0.0.1:${socksPort}`;
    env.all_proxy = env.ALL_PROXY;
  }

  say(head("\n── netfix 启动应用 ──\n"));
  say(`  ${info(`应用：${app}`)}`);
  say(`  ${info(`代理：http://127.0.0.1:${httpPort}${socksPort ? ` / socks5://127.0.0.1:${socksPort}` : ""}`)}`);
  say(`  ${dim(`NO_PROXY：${noProxyList}`)}`);

  if (args.flags["print-env"] === true) {
    say();
    return 0;
  }

  // Quit any running instance first so the new environment takes effect.
  const appName = app.replace(/\.app$/, "");
  try {
    await exec("osascript", ["-e", `quit app "${appName}"`], { timeout: 10000 });
  } catch {
    // not running
  }
  await new Promise((r) => setTimeout(r, 2500));

  const openArgs = ["-a", appName];
  for (const [key, value] of Object.entries(env)) {
    openArgs.push("--env", `${key}=${value}`);
  }
  await exec("open", openArgs, { timeout: 15000 });
  say(`\n  ${ok(`已使用 netfix 代理启动 ${appName}`)}\n`);
  return 0;
}

export async function cmdService(args) {
  const action = args._[1] || args.flags.action || "status";
  const forward = ["proxy", ...process.argv.slice(4)];

  if (action === "install") {
    const { plist } = await installService({ args: forward });
    say(`\n  ${ok("已将转发服务安装为 launchd 常驻代理")}`);
    say(dim(`    ${plist}`));
    const status = await serviceStatus();
    say(`  ${status.running ? ok(`运行中（pid ${status.pid}）`) : warn("尚未运行")}`);
    say(dim(`    日志：~/.netfix/proxy.log`));
    say(dim(`    停止：netfix service uninstall\n`));
    return status.running ? 0 : 1;
  }

  if (action === "uninstall" || action === "stop") {
    await uninstallService();
    say(`\n  ${ok("转发服务已移除")}\n`);
    return 0;
  }

  if (action === "logs") {
    const text = readServiceLog(40);
    say(text ? text : dim("  暂无日志 — 用 netfix service install 启动"));
    return 0;
  }

  const status = await serviceStatus();
  say(head("\n── netfix 服务 ──\n"));
  say(`  ${status.installed ? ok("launchd 常驻代理已安装") : warn("尚未安装")} ${dim(status.plist)}`);
  if (status.installed) {
    say(`  ${status.running ? ok(`运行中（pid ${status.pid}）`) : bad("已安装但未运行")}`);
  }
  say(dim("\n  netfix service install     # 开机自启，崩溃自动拉起"));
  say(dim("  netfix service uninstall   # 移除它"));
  say(dim("  netfix service logs\n"));
  return status.installed && status.running ? 0 : 0;
}

export async function cmdFix(args) {
  const internalDns = args.flags["internal-dns"] || DEFAULT_INTERNAL_DNS;
  const assumeYes = args.flags.yes === true || args.flags.y === true;
  const frontend = await pickFrontend(args);
  const adapter = resolveAdapter(frontend);

  say(head(`\n── netfix 修复（${frontend.label}）──\n`));

  const { file: targetFile } = await adapter.prepare();
  const conn = await connect(frontend);
  const api = conn.api;
  say(`  ${ok(`内核接口：${api.descriptor}`)}`);
  say(`  ${info(`目标文件：${targetFile}`)}`);

  const repoRoots = args.flags.repos
    ? String(args.flags.repos).split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const scanned = await scanAll({ repoRoots, includeChrome: args.flags["no-chrome"] !== true });
  say(`  ${info(`扫描到 ${scanned.hosts.length} 个候选域名`)}`);

  const results = await probeDomains(scanned.hosts.map((h) => h.host), internalDns);
  const { internal, fake } = partitionByKind(results);

  if (!internal.length) {
    say(`  ${warn("未检测到内网域名 — 无需修复")}`);
    return 0;
  }

  const suffixes = await validatedMerger(internalDns)(internal.map((r) => r.name));
  const existing = adapter.readCurrentDns();
  const dnsSection = buildDnsSection({
    internalDns,
    internalSuffixes: suffixes,
    existing,
  });

  const before = Object.keys(existing).length ? dumpYaml({ dns: existing }, 0) : "";
  const after = dumpYaml({ dns: dnsSection }, 0);

  say(head("\n  检测到的内网域名："));
  for (const r of internal.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 30)) {
    say(`    ${r.name.padEnd(50)} ${dim(r.ips.join(", "))}`);
  }
  if (internal.length > 30) say(dim(`    …… 还有 ${internal.length - 30} 个`));

  say(head(`\n  将要配置的后缀（${suffixes.length}）：`));
  for (const s of suffixes) say(`    +.${s}`);

  const diff = renderDiff(before, after);
  say(head("\n  配置差异："));
  if (diff.trim()) {
    for (const line of diff.split("\n")) {
      if (line.startsWith("+")) say(paint(C.green, `    ${line}`));
      else if (line.startsWith("-")) say(paint(C.red, `    ${line}`));
      else say(dim(`    ${line}`));
    }
  } else {
    say(dim("    （无变化）"));
  }

  if (!diff.trim()) {
    say(`\n  ${ok("配置已经是最新状态")}\n`);
    return 0;
  }

  if (!assumeYes) {
    const answer = await prompt("确认应用这些改动？[y/N] ");
    if (!/^y(es)?$/i.test(answer.trim())) {
      say(`\n  ${warn("已取消 — 未写入任何内容")}\n`);
      return 1;
    }
  }

  const backup = backupDir();
  fs.mkdirSync(backup, { recursive: true });
  const backupFile = path.join(backup, path.basename(targetFile));
  fs.copyFileSync(targetFile, backupFile);
  say(`\n  ${info(`备份：${backupFile}`)}`);

  await adapter.apply(dnsSection);
  say(`  ${ok("配置已写入")}`);

  say(`  ${info(adapter.id === "clash-verge-rev" ? "正在重启 Clash Verge…" : "正在重载内核…")}`);
  await adapter.reload(api);
  await new Promise((r) => setTimeout(r, adapter.id === "clash-verge-rev" ? 9000 : 2000));

  const verify = await verifyFix(
    internal.map((r) => r.name),
    suffixes,
    internalDns,
    api,
  );
  if (verify.ok) {
    say(`  ${ok("校验通过 — 内网域名均解析到私网地址")}`);
    const checks = await Promise.all(
      internal.slice(0, 5).map((r) => httpCheck(r.name)),
    );
    for (const c of checks) {
      if (c.status) say(dim(`    ${c.host} → HTTP ${c.status}`));
      else say(dim(`    ${c.host} → ${c.error} (HTTP check is advisory only)`));
    }
    say();
    return 0;
  }

  say(`  ${bad(`校验失败：${verify.reason}`)}`);
  say(`  ${info(`正在从备份恢复：${backupFile}`)}`);
  fs.copyFileSync(backupFile, targetFile);
  try {
    await adapter.reload(api);
  } catch {
    say(dim("    （重载失败 — 请手动重启代理客户端）"));
  }
  say(`  ${warn("已回滚")}\n`);
  return 1;
}

async function verifyFix(hosts, suffixes, internalDns, api) {
  // Hard gate: every host we classified as internal must still resolve to a
  // private IP. A suffix that resolves publicly is fine — some of them are
  // only split-horizon for a subset of their hosts.
  for (const host of hosts) {
    const res = await classifyDomain(host, internalDns);
    if (res.kind !== "internal") {
      return {
        ok: false,
        reason: `${host} resolved to ${res.ips.join(",") || res.error} (expected a private IP)`,
      };
    }
  }

  // The collapsed suffix must at least resolve for real (never fake-ip),
  // otherwise the core is still handing out synthetic addresses.
  for (const suffix of suffixes) {
    const res = await classifyDomain(suffix, internalDns);
    if (res.kind === "fake") {
      return { ok: false, reason: `core still returns fake-ip for ${suffix}` };
    }
  }

  if (api) {
    try {
      const answers = await api.dnsAnswers(hosts[0] ?? suffixes[0] ?? "localhost");
      if (answers.some((ip) => ip.startsWith("198.18."))) {
        return { ok: false, reason: `core still returns fake-ip for ${hosts[0]}` };
      }
    } catch {
      // core may still be restarting; the DNS checks above are the primary signal
    }
  }

  return { ok: true };
}

function httpCheck(host) {
  return new Promise((resolve) => {
    const req = https.request(
      { host, port: 443, path: "/", method: "GET", timeout: 6000, rejectUnauthorized: false },
      (res) => {
        res.resume();
        resolve({ host, status: res.statusCode });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ host, error: "timeout" });
    });
    req.on("error", (err) => resolve({ host, error: err.code || err.message }));
    req.end();
  });
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close();
    resolve(answer);
  }));
}

export const HELP = `
${head("netfix")} — 代理与内网 DNS 诊断／修复工具

${head("用法")}
  netfix                     启动图形界面（TUI）
  netfix doctor [选项]       诊断环境、程序与内网域名
  netfix scan [选项]         列出候选域名及其解析结果
  netfix fix [选项]          生成方案 → 预览差异 → 确认 → 应用 → 校验
  netfix proxy [选项]        启动本地转发代理，把代理能力交给工具
  netfix launch [应用]       带代理环境重启某个应用
  netfix service <操作>      install | uninstall | status | logs

${head("选项")}
  --internal-dns <ip>   内网 DNS 服务器（默认 ${DEFAULT_INTERNAL_DNS}）
  --repos <路径>        逗号分隔的仓库根目录，用于扫描域名
  --no-chrome           跳过 Chrome 历史记录（需要完全磁盘访问权限）
  --frontend <id>       指定前端：clash-verge-rev | generic-mihomo
  --config <路径>       指定配置文件（通用前端）
  --port <n>            HTTP 代理端口（默认 8899）
  --socks-port <n>      SOCKS5 代理端口（默认 8898，设为 0 则禁用）
  --print-env           只打印环境变量后退出
  --no-scan             仅使用客户端配置，不做实时扫描
  --app <名称>          要启动的应用（默认 Antigravity）
  --yes, -y             跳过确认提示
  --help, -h            显示帮助

${head("示例")}
  netfix
  netfix doctor
  netfix scan --repos ~/company
  netfix fix --yes
  netfix proxy
  netfix launch Antigravity
`;

export async function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0];

  if (args.flags.help || args.flags.h) {
    console.log(HELP);
    return 0;
  }

  if (!cmd || cmd === "tui" || cmd === "ui") {
    if (!process.stdout.isTTY) {
      // 没有交互式终端时退化成纯文本输出，方便在管道里看状态。
      const { renderStaticSummary } = await import("./tui/app.js");
      console.log(
        await renderStaticSummary({
          internalDns: args.flags["internal-dns"] || DEFAULT_INTERNAL_DNS,
          repoRoots: args.flags.repos
            ? String(args.flags.repos).split(",").map((s) => s.trim()).filter(Boolean)
            : [],
          includeChrome: args.flags["no-chrome"] !== true,
        }),
      );
      return 0;
    }
    const { runTui } = await import("./tui/app.js");
    return await runTui({
      internalDns: args.flags["internal-dns"] || DEFAULT_INTERNAL_DNS,
      repoRoots: args.flags.repos
        ? String(args.flags.repos).split(",").map((s) => s.trim()).filter(Boolean)
        : [],
      includeChrome: args.flags["no-chrome"] !== true,
    });
  }

  try {
    switch (cmd) {
      case "doctor":
        return await cmdDoctor(args);
      case "scan":
        return await cmdScan(args);
      case "fix":
        return await cmdFix(args);
      case "proxy":
        return await cmdProxy(args);
      case "service":
        return await cmdService(args);
      case "launch":
        return await cmdLaunch(args);
      default:
        console.error(`未知命令：${cmd}`);
        say(HELP);
        return 1;
    }
  } catch (err) {
    console.error(bad(`\n${err.message}\n`));
    if (process.env.NETFIX_DEBUG) console.error(err.stack);
    return 1;
  }
}
