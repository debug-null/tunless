// 出口地区采样：只记录某一个目的地这次看到的国家码。
// 它不是目标服务、账号权限或模型目录的结论。不同域名可以走不同节点。

import tls from "node:tls";
import zlib from "node:zlib";
import { openUpstreamTunnel } from "./relay.js";

// 常见会裁剪模型目录的地区。命中只给样本警告，不把单个目标判死。
const RESTRICTED_COUNTRIES = new Set([
  "CN", // 中国大陆
  "HK", // 中国香港 —— 三家都不服务，实测重灾区
  "MO", // 中国澳门
  "RU", // 俄罗斯
  "BY", // 白俄罗斯
  "IR", // 伊朗（OFAC）
  "KP", // 朝鲜（OFAC）
  "CU", // 古巴（OFAC）
  "SY", // 叙利亚（OFAC）
  "VE", // 委内瑞拉（OFAC）
  "AF", "LY", "SO", "SD", "SS", "YE", "MM", "ER", "ET", "CF",
]);

const GEO_URL = "https://ipinfo.io/json";
const GEO_HOST = "ipinfo.io";
const CACHE_TTL_MS = 15 * 60 * 1000;

const cache = new Map(); // key: upstream|target|path -> { at, egress }

export function restrictedEgress(country) {
  return RESTRICTED_COUNTRIES.has(String(country ?? "").toUpperCase());
}

/** 国家码只是某一次采样。不能据此说目标、账号或模型目录可用。 */
export function describeEgress(eg) {
  if (!eg?.country) return null;
  return {
    restricted: !!eg.restricted,
    text: `出口样本${eg.country}，不能判断目标、账号或模型目录`,
  };
}

export function egressCacheKey(upstream, target, requestPath) {
  return `${upstream?.host}:${upstream?.port}|${target}|${requestPath}`;
}

/**
 * 经上游代理问一次 geo 服务，拿到出口 IP 的国家码。
 * upstream: { host, port, protocols? } —— 与 openUpstreamTunnel 同构。
 * 失败返回 null（未知 ≠ 受限，绝不多报）。
 */
export async function detectEgress(upstream, {
  timeoutMs = 6000,
  target = GEO_HOST,
  path = "/json",
  ca,
} = {}) {
  if (!upstream?.host || !upstream?.port) return null;
  const key = egressCacheKey(upstream, target, path);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.egress;

  const egress = await queryGeo(upstream, timeoutMs, target, path, ca).catch(() => null);
  // 失败和被拒绝的响应不缓存成「有国家」，避免 429 正文把错误出口钉住。
  if (egress?.country) cache.set(key, { at: Date.now(), egress });
  return egress;
}

export function egressFromHttp(raw) {
  const msg = parseHttpMessage(raw);
  if (!msg || msg.encodingError || msg.status !== 200 || !msg.body) return null;
  let data;
  try {
    data = JSON.parse(msg.body.toString("utf8").trim());
  } catch {
    return null;
  }
  if (!data || typeof data.country !== "string" || !data.country) return null;
  return {
    ip: data.ip ?? null,
    country: data.country,
    region: data.region ?? null,
    org: data.org ?? null,
    restricted: restrictedEgress(data.country),
    sample: true,
    serviceVerified: false,
  };
}

function parseHttpMessage(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), "latin1");
  const splitAt = buf.indexOf("\r\n\r\n");
  if (splitAt < 0) return null;
  const head = buf.subarray(0, splitAt).toString("latin1");
  let body = buf.subarray(splitAt + 4);
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1] ?? 0);
  const headers = {};
  for (const line of head.split("\r\n").slice(1)) {
    const idx = line.indexOf(":");
    if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  if (/chunked/i.test(headers["transfer-encoding"] || "")) {
    const decoded = decodeChunked(body);
    if (!decoded) return { status, headers, body: null, encodingError: true };
    body = decoded;
  }
  if (/gzip/i.test(headers["content-encoding"] || "")) {
    try {
      body = zlib.gunzipSync(body);
    } catch {
      return { status, headers, body: null, encodingError: true };
    }
  }
  return { status, headers, body, encodingError: false };
}

function decodeChunked(body) {
  const out = [];
  let offset = 0;
  while (offset < body.length) {
    const lineEnd = body.indexOf("\r\n", offset);
    if (lineEnd < 0) return null;
    const len = Number.parseInt(body.subarray(offset, lineEnd).toString("latin1").split(";")[0], 16);
    if (!Number.isFinite(len)) return null;
    const start = lineEnd + 2;
    if (len === 0) return Buffer.concat(out);
    const end = start + len;
    if (end + 2 > body.length) return null;
    out.push(body.subarray(start, end));
    offset = end + 2;
  }
  return null;
}

async function queryGeo(upstream, timeoutMs, target, requestPath, ca) {
  const socket = await openUpstreamTunnel(upstream, target, 443, timeoutMs);
  try {
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        conn.destroy();
        if (err) reject(err);
        else resolve(value);
      };
      const conn = tls.connect(
        {
          socket,
          servername: target,
          ALPNProtocols: ["http/1.1"],
          ca,
          rejectUnauthorized: true,
        },
        () => {
          conn.write(
            `GET ${requestPath} HTTP/1.1\r\nHost: ${target}\r\nUser-Agent: tunless\r\nAccept: application/json\r\nConnection: close\r\n\r\n`,
          );
        },
      );
      const timer = setTimeout(() => finish(new Error("geo 查询超时")), timeoutMs);
      const chunks = [];
      conn.on("data", (c) => chunks.push(c));
      conn.once("error", (e) => {
        clearTimeout(timer);
        finish(e);
      });
      conn.once("close", () => {
        clearTimeout(timer);
        finish(null, egressFromHttp(Buffer.concat(chunks)));
      });
    });
  } finally {
    socket.destroy?.();
  }
}

/** 测试用：清掉缓存 */
export function _resetEgressCache() {
  cache.clear();
}
