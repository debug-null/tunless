// 「测外网」到底该测谁。
//
// 以前固定测 github.com —— 但 github 通不通，跟 Antigravity 能不能登录没有关系。
// 用户实际看到的报错是：
//   Post "https://oauth2.googleapis.com/token": dial tcp 172.253.117.95:443: i/o timeout
// 也就是说要测的是「这个工具自己会去连的那个域名」。
//
// 所以按应用给默认目标（都是从二进制里读出来的真实域名，不是猜的），
// 同时允许用户手写任意目标 —— 认不出来的工具、私有网关、自建模型服务都靠这个。

import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./paths.js";

// 默认目标：host + 端口 + 路径。
// 路径只是为了拿到一个「服务器真的回了话」的证据，不要求 200。
//
// 这些域名不是从文档里抄的，而是从本机代理日志里统计出来的真实连接
// （~/.tunless/proxy.log 里 CONNECT 的频次）+ 二进制里的字符串交叉验证：
//   Antigravity → daily-cloudcode-pa / play / oauth2 / www.googleapis.com
//   Cursor      → api2 / api3 / api.cursor.com / agentn.global.api5
export const APP_TARGETS = {
  antigravity: [
    { host: "oauth2.googleapis.com", port: 443, path: "/token", label: "登录换 token" },
    // 模型流量走的是 daily 这个域，不是 cloudcode-pa 本身
    {
      host: "daily-cloudcode-pa.googleapis.com",
      port: 443,
      path: "/",
      label: "模型接口",
    },
    { host: "play.googleapis.com", port: 443, path: "/", label: "客户端遥测" },
    { host: "www.googleapis.com", port: 443, path: "/", label: "Google API" },
  ],
  cursor: [
    { host: "api2.cursor.sh", port: 443, path: "/", label: "Agent 接口" },
    { host: "api3.cursor.sh", port: 443, path: "/", label: "Agent 接口（v3）" },
    { host: "api.cursor.com", port: 443, path: "/", label: "账号与订阅" },
    // 裸 api5.cursor.sh 在多数网络下 TLS 都握手失败（直连也报 SSL error），
    // 真正可用的是这个子域；依旧标成可选，它挂了不代表 tunless 有问题。
    {
      host: "agentn.global.api5.cursor.sh",
      port: 443,
      path: "/",
      label: "Agent 接口（备用）",
      optional: true,
    },
  ],
  codex: [
    { host: "chatgpt.com", port: 443, path: "/", label: "桌面客户端" },
    { host: "api.openai.com", port: 443, path: "/v1/models", label: "API" },
  ],
};

/** 什么应用都没选时用的兜底目标 */
export const DEFAULT_TARGETS = [
  { host: "github.com", port: 443, path: "/", label: "通用" },
];

export function targetsForApp(appId) {
  return APP_TARGETS[appId] ? [...APP_TARGETS[appId]] : [...DEFAULT_TARGETS];
}

export function targetsFile() {
  return path.join(dataDir(), "targets.json");
}

/**
 * 解析用户手写的目标：
 *   api2.cursor.sh
 *   api2.cursor.sh:8443
 *   https://example.com/health
 *   10.1.2.3:8080
 */
export function parseTarget(raw) {
  let value = String(raw ?? "").trim();
  if (!value) return null;
  value = value.replace(/^https?:\/\//i, "");
  const slash = value.indexOf("/");
  const hostPort = slash === -1 ? value : value.slice(0, slash);
  const rest = slash === -1 ? "" : value.slice(slash);

  let host = hostPort;
  let port = 443;
  const idx = hostPort.lastIndexOf(":");
  if (idx !== -1 && hostPort.indexOf("]") === -1) {
    const maybePort = Number(hostPort.slice(idx + 1));
    if (Number.isFinite(maybePort) && maybePort > 0 && maybePort <= 65535) {
      host = hostPort.slice(0, idx);
      port = maybePort;
    }
  }
  if (!host) return null;
  // 只接受主机名 / IP，避免把随手输入的句子当成域名去连
  if (!/^[a-zA-Z0-9._-]+$/.test(host)) return null;
  return { host, port, path: rest || "/", label: "手动添加" };
}

export function loadCustomTargets() {
  try {
    const data = JSON.parse(fs.readFileSync(targetsFile(), "utf8"));
    if (!Array.isArray(data)) return [];
    return data
      .map((item) => parseTarget(item))
      .filter(Boolean)
      .map((t) => ({ ...t, custom: true }));
  } catch {
    return [];
  }
}

export function saveCustomTargets(targets) {
  fs.mkdirSync(dataDir(), { recursive: true });
  const list = targets.map((t) => {
    const base = t.port === 443 ? t.host : `${t.host}:${t.port}`;
    return t.path && t.path !== "/" ? `${base}${t.path}` : base;
  });
  fs.writeFileSync(targetsFile(), `${JSON.stringify(list, null, 2)}\n`, "utf8");
  return targetsFile();
}

export function addCustomTarget(target) {
  const list = loadCustomTargets();
  const exists = list.some((t) => t.host === target.host && t.port === target.port);
  if (exists) return { targets: list, added: false };
  const next = [...list, { ...target, custom: true }];
  saveCustomTargets(next);
  return { targets: next, added: true };
}

/**
 * 删除自定义目标。
 *
 * port 省略时按主机名删掉所有端口 —— 用户输入 `targets remove api.example.com`
 * 时心里想的是「把这条去掉」，不是「只删 443 那一条」。
 */
export function removeCustomTarget(host, port = null) {
  const list = loadCustomTargets();
  const next = list.filter(
    (t) => !(t.host === host && (port === null || t.port === port)),
  );
  saveCustomTargets(next);
  return { targets: next, removed: next.length !== list.length };
}

/** 应用默认目标 + 用户手写的，去重后一起测 */
export function resolveTargets(appId, { includeCustom = true } = {}) {
  const base = targetsForApp(appId);
  if (!includeCustom) return base;
  const extra = loadCustomTargets();
  const seen = new Set(base.map((t) => `${t.host}:${t.port}`));
  return [...base, ...extra.filter((t) => !seen.has(`${t.host}:${t.port}`))];
}
