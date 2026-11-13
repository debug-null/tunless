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
import { execFile, execFileSync } from "node:child_process";
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
    // 只注入环境变量就够用：language_server 是 Go 程序，会读 HTTPS_PROXY
    envOnlyEnough: true,
    // 推荐的处理方式（对应 app-menu.js 里的 action id）
    recommendedAction: "env",
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
    // 只注入环境变量不够：Agent 不读环境变量代理，必须写 settings.json
    envOnlyEnough: false,
    recommendedAction: "env+settings",
  },
  {
    id: "codex",
    name: "Codex",
    kind: "cli",
    // Codex 有两种形态，但共用同一套配置：
    //   1. 终端里的 codex 命令（npm / brew 安装）
    //   2. 桌面客户端 ChatGPT.app（里面内置了一个 codex 二进制跑 app-server）
    // 两者都是 Rust 程序，都读 CODEX_HOME/.env，所以一份配置同时管两边。
    bin: "codex",
    desktopBundle: "ChatGPT",
    // Codex 会解析 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY；
    // 但它启动时还会读 CODEX_HOME/.env，且那个文件的优先级更高 ——
    // 所以光给环境变量会被 .env 里的旧值盖掉，必须同时改 .env。
    envOnlyEnough: false,
    recommendedAction: "env+settings",
    // 配置目录：CODEX_HOME 或 ~/.codex
    configDir: () => process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    description: "终端命令 + 桌面客户端共用 ~/.codex/.env",
  },
];

export function findApp(id = "antigravity") {
  return APPS.find((a) => a.id === id || a.name.toLowerCase() === String(id).toLowerCase()) ?? null;
}

export async function isAppInstalled(app) {
  if (!app) return false;
  // CLI 类应用：在 PATH 里找得到就算装了
  if (app.bin) {
    try {
      await exec("sh", ["-lc", `command -v ${app.bin}`], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
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

/** CLI 应用的版本号：跑 `<bin> --version` 取第一行里的版本 */
export function cliVersion(app) {
  if (!app?.bin) return null;
  try {
    const out = execFileSync("sh", ["-lc", `${app.bin} --version`], {
      timeout: 8000,
      encoding: "utf8",
    });
    const m = /(\d+\.\d+\.\d+)/.exec(out);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Codex 的代理配置文件：<CODEX_HOME>/.env
 *
 * 关键事实（实测）：Codex 启动时会读这个文件把它注入进程环境，
 * 而且优先级高于外面传进来的 HTTPS_PROXY。所以只给环境变量会被它盖掉，
 * 表现为「设了代理却还是走系统代理」。改这个文件才真正生效。
 */
export function codexEnvPath(app = null) {
  const target = app ?? findApp("codex");
  const dir = target?.configDir ? target.configDir() : path.join(os.homedir(), ".codex");
  return path.join(dir, ".env");
}

/** 读 Codex 的 .env：返回原始行与解析后的键值 */
export function readCodexEnv(app = null) {
  const file = codexEnvPath(app);
  if (!fs.existsSync(file)) return { file, exists: false, raw: "", data: {} };
  const raw = fs.readFileSync(file, "utf8");
  const data = {};
  for (const line of raw.split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    data[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return { file, exists: true, raw, data };
}

/**
 * 只改 .env 里我们关心的三个键，其余行（注释、其它变量）原样保留。
 * 缺键就追加到末尾；值变了就替换那一行。
 */
export function applyEnvText(raw, changes) {
  const original = raw ?? "";
  const lines = original.split("\n");
  const pending = new Map(Object.entries(changes));

  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(lines[i]);
    if (!m) continue;
    const key = m[1];
    if (!pending.has(key)) continue;
    lines[i] = `${key}=${pending.get(key)}`;
    pending.delete(key);
  }

  if (pending.size) {
    // 别把内容粘到最后一行空行后面
    while (lines.length && lines[lines.length - 1] === "") lines.pop();
    for (const [key, value] of pending) lines.push(`${key}=${value}`);
  }

  // 保持结尾换行，避免下次读的时候拼在一起
  const text = lines.join("\n");
  return text.endsWith("\n") ? text : `${text}\n`;
}

/**
 * Codex 桌面客户端（ChatGPT.app）是否在运行。
 * 在运行的话，改完 .env 必须重启它才生效 —— 它启动时就把 .env 读进内存了。
 */
export async function codexDesktopRunning() {
  // 不用 pgrep -f：在受限沙箱里它看不到别的进程，改用 ps 全表再过滤。
  try {
    const { stdout } = await exec("ps", ["-Ao", "pid=,command="], {
      timeout: 8000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const pids = stdout
      .split("\n")
      .filter((line) => /\/ChatGPT\.app\/Contents\/MacOS\/ChatGPT(\s|$)/.test(line))
      .map((line) => Number(line.trim().split(/\s+/)[0]))
      .filter((n) => Number.isFinite(n) && n > 0);
    return { running: pids.length > 0, pids };
  } catch {
    return { running: false, pids: [] };
  }
}

/**
 * 某个应用「实际」连的是哪个本地代理端口。
 *
 * 这是整个工具最该说真话的地方：配置写对了 ≠ 流量真的走了代理。
 * 判断依据是进程的真实 TCP 连接，不是我们写了什么文件。
 *
 *  - Codex：网络在 app-server 子进程里，看 codex-cli 那些进程。
 *  - Cursor / Antigravity：主进程是 Electron，Agent / language_server 是子进程，
 *    所以要把整个进程树都扫一遍，不能只看主进程。
 */
export async function appProxyPorts(app) {
  if (!app) return { pids: [], ports: [] };

  // 注意：不能只匹配主进程。真正联网的往往是子进程 ——
  // Antigravity 的 language_server、Cursor 的 Plugin Helper 都在 .app 目录下，
  // 只盯 MainOS/<Bundle> 会永远得到「没有代理连接」这个假结论。
  const targets =
    app.id === "codex"
      ? ["codex-cli/CodexCLI.app/Contents/MacOS/codex"]
      : [`/Applications/${app.bundle}.app/`];

  try {
    const { stdout } = await exec("ps", ["-Ao", "pid=,command="], {
      timeout: 8000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const pids = stdout
      .split("\n")
      .filter((line) => targets.some((t) => line.includes(t)))
      .map((line) => Number(line.trim().split(/\s+/)[0]))
      .filter((n) => Number.isFinite(n) && n > 0);

    return { pids, ports: await proxyPortsForPids(pids) };
  } catch {
    return { pids: [], ports: [] };
  }
}

/**
 * 一次 lsof 取回所有进程的已建立连接，再按 pid 过滤。
 * 逐个 pid 调 lsof 在 Electron 应用上要跑十几次，慢到界面会卡住。
 */
export async function proxyPortsForPids(pids) {
  if (!pids?.length) return [];
  try {
    const { stdout } = await exec("lsof", ["-nP", "-iTCP"], {
      timeout: 15000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return parseProxyPorts(stdout, pids);
  } catch {
    return [];
  }
}

/** 常见本地代理端口：Clash 系列、tunless、通用 SOCKS/HTTP 端口。 */
const KNOWN_PROXY_PORTS = new Set([7897, 7890, 7891, 8899, 8898, 1080, 1087, 10808, 8080, 8888]);

/**
 * 从 `lsof -nP -iTCP` 的输出里挑出「连到本地代理」的端口号。
 *
 * 这里要过滤两类噪音，否则 Electron 应用会把界面骗了：
 *   1. 应用自己监听的端口（language_server 的 54310 之类）——内部 IPC；
 *   2. 随机临时端口上的内部回环连接（macOS 临时端口从 49152 起）。
 * 只看这些会把 `unknown` 说成「没走代理」，或者干脆报一堆假端口。
 */
export function parseProxyPorts(lsofOutput, pids) {
  const wanted = new Set(pids ?? []);
  if (!wanted.size) return [];

  const ownPorts = new Set();
  const rows = [];
  for (const line of String(lsofOutput).split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 9) continue;
    const pid = Number(cols[1]);
    if (!wanted.has(pid)) continue;
    rows.push(cols);
    // 应用自己监听的端口是内部 IPC，不是代理
    if ((cols[9] ?? "").startsWith("(LISTEN)")) {
      const local = /:(\d+)$/.exec(cols[8] ?? "");
      if (local) ownPorts.add(Number(local[1]));
    }
  }

  const ports = new Set();
  for (const cols of rows) {
    // 形如 127.0.0.1:54328->127.0.0.1:8899
    const m = /->127\.0\.0\.1:(\d+)/.exec(cols[8] ?? "");
    if (!m) continue;
    const port = Number(m[1]);
    if (ownPorts.has(port)) continue;
    if (port >= 49152 && !KNOWN_PROXY_PORTS.has(port)) continue;
    ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

/**
 * 判断「实际走没走 tunless」。
 * 返回三种状态：ok（确实走 8899）/ stale（在走别的代理）/ not-running。
 */
export function proxyVerdict({ pids = [], ports = [] }, tunlessPort = 8899) {
  if (!pids.length) return { state: "not-running", ports };
  if (ports.includes(tunlessPort)) return { state: "ok", ports };
  if (ports.length) return { state: "stale", ports };
  // 进程在跑但此刻没有走代理的连接（可能只是还没发请求）
  return { state: "unknown", ports };
}

/**
 * 桌面客户端的网络实际由它内部的 codex 子进程（app-server）负责。
 * 所以要看「客户端现在走哪个代理」，得看这些子进程的连接。
 */
export async function codexDesktopProxyPorts() {
  try {
    const { stdout } = await exec("ps", ["-Ao", "pid=,command="], {
      timeout: 8000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const pids = stdout
      .split("\n")
      .filter((line) => line.includes("codex-cli/CodexCLI.app/Contents/MacOS/codex"))
      .map((line) => Number(line.trim().split(/\s+/)[0]))
      .filter((n) => Number.isFinite(n) && n > 0);
    const ports = new Set();
    for (const pid of pids) {
      const found = await processProxyPort(pid);
      for (const port of found ?? []) ports.add(port);
    }
    return { pids, ports: [...ports] };
  } catch {
    return { pids: [], ports: [] };
  }
}

/**
 * 看某个进程现在实际连的是哪个本地代理端口。
 *
 * 这是判断「配置改了到底生效没有」最直接的证据：
 * 配置写的是 8899，但进程还挂着 7897 的连接，就说明它需要重启。
 */
export async function processProxyPort(pid) {
  if (!pid) return null;
  try {
    const { stdout } = await exec("lsof", ["-nP", "-p", String(pid)], { timeout: 8000 });
    const ports = new Set();
    for (const line of stdout.split("\n")) {
      // 取「连接目标」那一侧：127.0.0.1:源端口->127.0.0.1:代理端口
      const m = /->127\.0\.0\.1:(\d+)/.exec(line);
      if (m) ports.add(Number(m[1]));
    }
    // 只关心里程碑端口：7897 这类是 Clash，8899 是 tunless
    return [...ports];
  } catch {
    return null;
  }
}

/** Codex .env 里的代理状态 */
export function codexProxyState(app = null) {
  const env = readCodexEnv(app);
  return {
    file: env.file,
    exists: env.exists,
    httpProxy: env.data.HTTP_PROXY ?? null,
    httpsProxy: env.data.HTTPS_PROXY ?? null,
    noProxy: env.data.NO_PROXY ?? env.data.no_proxy ?? null,
  };
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

/**
 * 备份文件名里带原文件的完整路径（扁平化成 --），
 * 这样 restore 才知道每份备份该还原到哪，
 * 否则 `settings.json` 这种同名文件根本分不清是 Cursor 的还是 Antigravity 的。
 */
function encodePathForBackup(file) {
  return path.resolve(file).replace(/^\//, "").replace(/[\/]/g, "--");
}

export function backupFile(file) {
  const dir = path.join(dataDir(), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(dir, `${stamp}--${encodePathForBackup(file)}`);
  fs.copyFileSync(file, dest);
  return dest;
}

/**
 * 列出现有备份，最新的在前。
 *
 * 旧版本备份名是 `<时间戳>-<文件名>`，没有原路径，还原不了；
 * 这种标记成 legacy，界面上只说「来自旧版本」，不假装能还原。
 */
export function listBackups() {
  const dir = path.join(dataDir(), "backups");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .map((name) => {
      const full = path.join(dir, name);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) return null;
      const target = decodePathFromBackup(name);
      return {
        file: full,
        name,
        target,
        legacy: !target,
        mtime: stat.mtime,
        size: stat.size,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
}

/** 从备份文件名还原出原始路径（`Users--a--b--settings.json` → `/Users/a/b/settings.json`） */
export function decodePathFromBackup(name) {
  // 形如 2026-11-13T04-12-40-190Z--Users--x--.codex--.env
  const m = /^\d{4}-\d{2}-\d{2}T[\d-]+Z--(.+)$/.exec(name);
  if (!m) return null;
  return `/${m[1].replace(/--/g, "/")}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 应用的主进程 pid（Electron 应用会有几十个 helper，只看主进程） */
export async function mainPid(app) {
  // CLI 工具（codex）跑完就退出，没有长期驻留的主进程
  if (app?.bin) return null;
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
