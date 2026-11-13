// 受支持的应用：怎么找到它、它认哪种代理配置、怎么带代理重启。
//
// 不同应用的差别很大，这不是「统一设置一个环境变量」能解决的事：
//
//   Antigravity  继承 ELECTRON/Chromium 行为，环境变量基本够用
//   Cursor       Chromium 部分认 http.proxy，但 Agent 走自己的 Node 传输层；
//                3.28 之前 HTTP/2 通路完全绕开代理，3.28 起才支持 CONNECT 隧道。
//                所以除了环境变量，还必须写 settings.json 并在必要时关掉 HTTP/2。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dataDir } from "./paths.js";

const exec = promisify(execFile);

export const APPS = [
  {
    id: "antigravity",
    name: "Antigravity",
    bundle: "Antigravity",
    kind: "vscode",
    // Antigravity 是 VS Code 系的 Electron 应用，Chromium 部分和 Cursor 一样
    // 读 http.proxy；真正访问模型的是 language_server（Go 程序，支持 HTTPS_PROXY）。
    settingsPath: () =>
      path.join(
        os.homedir(),
        "Library/Application Support/Antigravity/User/settings.json",
      ),
    description: "模型走 language_server（认 HTTPS_PROXY）",
    // 这个应用没有 Cursor 那种独立的 Agent 传输层，不需要动 HTTP/2
    supportsHttp2Tunnel: true,
  },
  {
    id: "cursor",
    name: "Cursor",
    bundle: "Cursor",
    kind: "vscode",
    settingsPath: () =>
      path.join(
        os.homedir(),
        "Library/Application Support/Cursor/User/settings.json",
      ),
    description: "Agent 有独立传输层，3.28 前会绕过代理",
    // 3.28 起 Agent 的 HTTP/2 才会走 CONNECT 隧道
    supportsHttp2Tunnel: false,
  },
];

export function findApp(id = "antigravity") {
  return APPS.find((a) => a.id === id || a.name.toLowerCase() === String(id).toLowerCase()) ?? null;
}

export async function isAppInstalled(app) {
  if (!app) return false;
  try {
    await exec("open", ["-Ra", app.bundle], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export function cursorSettingsPath() {
  return path.join(
    os.homedir(),
    "Library/Application Support/Cursor/User/settings.json",
  );
}

/** 应用版本号，从 /Applications/<Name>.app 的 Info.plist 读 */
export function appVersion(bundle = "Cursor") {
  const plist = `/Applications/${bundle}.app/Contents/Info.plist`;
  if (!fs.existsSync(plist)) return null;
  try {
    const buf = fs.readFileSync(plist, "utf8");
    const m = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(buf);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

export function cursorVersion() {
  return appVersion("Cursor");
}

/**
 * settings.json 是 JSONC（允许注释和尾逗号），JSON.parse 会直接失败。
 * 这里只做「够用」的容错：去掉行注释、块注释和尾逗号，再解析。
 * 写回时保留原文的键顺序，只增改我们关心的几个键。
 */
export function stripJsonc(text) {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (c === "\n") {
        inLine = false;
        out += c;
      }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += c;
      if (c === "\\") {
        out += next ?? "";
        i += 1;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === "/" && next === "/") {
      inLine = true;
      i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlock = true;
      i += 1;
      continue;
    }
    out += c;
  }
  // 去掉尾逗号：{"a":1,} / [1,2,]
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export function readAppSettings(app) {
  const file = app?.settingsPath ? app.settingsPath() : cursorSettingsPath();
  return readCursorSettings(file);
}

export function readCursorSettings(file = cursorSettingsPath()) {
  if (!fs.existsSync(file)) return { file, exists: false, raw: "", data: {} };
  const raw = fs.readFileSync(file, "utf8");
  try {
    const data = JSON.parse(stripJsonc(raw));
    return { file, exists: true, raw, data: data && typeof data === "object" ? data : {} };
  } catch (err) {
    return { file, exists: true, raw, data: {}, parseError: err.message };
  }
}

export function cursorProxyState(settings) {
  const data = settings?.data ?? {};
  return {
    httpProxy: data["http.proxy"] ?? null,
    proxySupport: data["http.proxySupport"] ?? null,
    disableHttp2: data["cursor.general.disableHttp2"] === true,
  };
}

/**
 * 版本比较：3.28.7 → [3,28,7]。
 * 3.28 起 Agent 的 HTTP/2 会走 CONNECT 隧道，不需要再关 HTTP/2；
 * 更早的版本必须关，否则模型请求直接绕过代理。
 */
export function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function http2TunnelSupported(version) {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  const [major, minor] = parsed;
  return major > 3 || (major === 3 && minor >= 28);
}

/**
 * 计算需要写进 settings.json 的键。
 * 返回 { changes, warnings }，changes 是「要写成什么」，warnings 是要告诉用户的。
 */
export function planCursorSettings({ proxyUrl, version, app = null }) {
  const changes = {
    "http.proxy": proxyUrl,
    "http.proxySupport": "override",
  };
  const warnings = [];
  const name = app?.name ?? "Cursor";

  // 只有 Cursor 有「Agent 走独立 HTTP/2 传输层」这个问题。
  // Antigravity 的模型请求在 language_server（Go 程序）里，认 HTTPS_PROXY 就行。
  if (app && app.supportsHttp2Tunnel) {
    return { changes, warnings };
  }

  if (http2TunnelSupported(version)) {
    changes["cursor.general.disableHttp2"] = false;
  } else {
    changes["cursor.general.disableHttp2"] = true;
    warnings.push(
      `${name} ${version ?? "版本未知"} 的 Agent 在 HTTP/2 下会绕过代理，需要关闭 HTTP/2（升级到 3.28+ 后可去掉）`,
    );
  }
  return { changes, warnings };
}

/**
 * 把改动合并进 settings.json 原文。
 * 逐行替换已有的顶层键，缺失的插到最后一个 } 之前，尽量少动原文件。
 */
export function applyCursorSettingsText(raw, changes) {
  const original = raw && raw.trim() ? raw : "{}\n";
  const lines = original.split("\n");
  const pending = new Map(Object.entries(changes));
  const indentMatch = /\n(\s+)"/.exec(original);
  const indent = indentMatch ? indentMatch[1] : "  ";

  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)"([^"]+)"\s*:\s*/.exec(lines[i]);
    if (!m) continue;
    const key = m[2];
    if (!pending.has(key)) continue;
    const value = JSON.stringify(pending.get(key));
    pending.delete(key);
    // 保持原有缩进与逗号风格：值后面若原本有逗号就补上。
    // 这些键原本都是字符串/布尔，替换成单行不会破坏后面的行。
    const comma = lines[i].trimEnd().endsWith(",") ? "," : "";
    lines[i] = `${m[1]}"${key}": ${value}${comma}`;
  }

  if (pending.size) {
    // 找到最后的 }，在它前面插入
    let closeIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^\s*\}\s*$/.test(lines[i])) {
        closeIdx = i;
        break;
      }
    }
    const inserted = [...pending.entries()].map(([k, v]) => `${indent}"${k}": ${JSON.stringify(v)}`);
    if (closeIdx === -1) {
      return `{\n${inserted.join(",\n")}\n}\n`;
    }
    // 前一个有效行需要补逗号
    let prev = closeIdx - 1;
    while (prev >= 0 && !lines[prev].trim()) prev--;
    if (prev >= 0 && !/[{,]\s*$/.test(lines[prev])) lines[prev] = `${lines[prev].replace(/\s*$/, "")},`;
    lines.splice(closeIdx, 0, ...inserted.map((line, i) => (i < inserted.length - 1 ? `${line},` : line)));
  }
  return lines.join("\n");
}

export function backupFile(file) {
  const dir = path.join(dataDir(), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(dir, `${stamp}-${path.basename(file)}`);
  fs.copyFileSync(file, dest);
  return dest;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 应用的主进程 pid（Electron 应用会有几十个 helper，只看主进程） */
export async function mainPid(app) {
  try {
    const { stdout } = await exec("pgrep", ["-f", `${app.bundle}.app/Contents/MacOS/${app.bundle}$`], {
      timeout: 5000,
    });
    const pid = stdout.trim().split("\n")[0];
    return pid ? Number(pid) : null;
  } catch {
    return null;
  }
}

/**
 * 退出应用。
 *
 * Electron 应用（Cursor 就是）经常忽略 AppleScript 的 quit：
 * 系统认为「应用已收到退出请求」，但进程还在。只靠 osascript 会导致
 * 后面的 open 变成「应用已在运行，环境变量无法生效」。
 * 所以这里按 优雅请求 → SIGTERM → SIGKILL 逐级升级，并确认进程真的没了。
 */
export async function quitApp(app, { timeoutMs = 20000 } = {}) {
  const pid = await mainPid(app);
  if (!pid) return { quit: true, pid: null, escalated: false };

  try {
    await exec("osascript", ["-e", `quit app "${app.bundle}"`], { timeout: 8000 });
  } catch {
    // 没在运行或没有自动化权限
  }

  const deadline = Date.now() + timeoutMs * 0.4;
  while (Date.now() < deadline) {
    if (!(await mainPid(app))) return { quit: true, pid, escalated: false };
    await sleep(400);
  }

  // TERM：Electron 收到后会走正常退出流程，仍有时间刷盘
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // 已经退了
  }
  const termDeadline = Date.now() + timeoutMs * 0.4;
  while (Date.now() < termDeadline) {
    if (!(await mainPid(app))) return { quit: true, pid, escalated: true };
    await sleep(300);
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // 已经退了
  }
  const killDeadline = Date.now() + timeoutMs * 0.2;
  while (Date.now() < killDeadline) {
    if (!(await mainPid(app))) return { quit: true, pid, escalated: true };
    await sleep(200);
  }
  return { quit: false, pid, escalated: true };
}

export async function openApp(app, env) {
  const args = ["-a", app.bundle];
  for (const [key, value] of Object.entries(env ?? {})) args.push("--env", `${key}=${value}`);
  await exec("open", args, { timeout: 20000 });
}
