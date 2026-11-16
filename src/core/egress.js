// 出口地区检测：上游代理「通」不等于「AI 模型目录完整」。
//
// Cursor / Antigravity 的模型目录是按请求出口 IP 的地区下发的——
// 香港、大陆等地区的出口会被服务端裁掉 Gemini / Claude / GPT。
// 用户换了节点、URLTest 自动选了香港节点、机场节点悄悄变了归属，
// 都会让「模型怎么少了几个」变成一个看不见的谜。这里把出口地区
// 变成可见状态：连通性之外，多报一层「这个出口能不能用全模型」。

import tls from "node:tls";
import { openUpstreamTunnel } from "./relay.js";

// 主流 AI 服务（Google Gemini / OpenAI / Anthropic）不服务的国家与地区。
// 依据：三家官方支持地区列表的交集 —— 命中即模型目录会被裁剪。
// 名单宁紧勿宽：漏报只是少一条提醒，误报会吓用户。
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

const cache = new Map(); // key: "host:port" -> { at, egress }

export function restrictedEgress(country) {
  return RESTRICTED_COUNTRIES.has(String(country ?? "").toUpperCase());
}

/**
 * 经上游代理问一次 geo 服务，拿到出口 IP 的国家码。
 * upstream: { host, port, protocols? } —— 与 openUpstreamTunnel 同构。
 * 失败返回 null（未知 ≠ 受限，绝不多报）。
 */
export async function detectEgress(upstream, { timeoutMs = 6000 } = {}) {
  if (!upstream?.host || !upstream?.port) return null;
  const key = `${upstream.host}:${upstream.port}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.egress;

  const egress = await queryGeo(upstream, timeoutMs).catch(() => null);
  if (egress) cache.set(key, { at: Date.now(), egress });
  return egress;
}

async function queryGeo(upstream, timeoutMs) {
  const socket = await openUpstreamTunnel(upstream, GEO_HOST, 443, timeoutMs);
  try {
    return await new Promise((resolve, reject) => {
      const done = (err, val) => {
        conn.destroy();
        err ? reject(err) : resolve(val);
      };
      const conn = tls.connect(
        { socket, servername: GEO_HOST, ALPNProtocols: ["http/1.1"] },
        () => {
          conn.write(
            `GET /json HTTP/1.1\r\nHost: ${GEO_HOST}\r\nUser-Agent: tunless\r\nAccept: application/json\r\nConnection: close\r\n\r\n`,
          );
        },
      );
      conn.setTimeout(timeoutMs, () => done(new Error("geo 查询超时")));
      let raw = "";
      conn.on("data", (c) => (raw += c.toString("utf8")));
      conn.once("error", (e) => done(e));
      conn.once("close", () => {
        const body = raw.slice(raw.indexOf("\r\n\r\n") + 4);
        try {
          const d = JSON.parse(body.trim());
          resolve({
            ip: d.ip ?? null,
            country: d.country ?? null,
            region: d.region ?? null,
            org: d.org ?? null,
            restricted: restrictedEgress(d.country),
          });
        } catch (e) {
          done(e);
        }
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
