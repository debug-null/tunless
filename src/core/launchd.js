// Per-user launchd integration for the proxy sidecar, so it survives logout
// and reboots without a terminal window open.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dataDir } from "./paths.js";

const exec = promisify(execFile);

export const LABEL = "dev.tunless.proxy";
const AGENT_DIR = path.join(os.homedir(), "Library/LaunchAgents");
export const PLIST_PATH = path.join(AGENT_DIR, `${LABEL}.plist`);
export const LOG_DIR = dataDir();

/**
 * 写进 launchd 用户会话的代理环境变量。
 *
 * 为什么需要这个：`open --env` 只在**我们自己启动**的那一次有效。
 * 用户从 Dock / Finder / Spotlight 点开应用时，环境里什么都没有 ——
 * 于是 Antigravity 的 language_server 会直连 oauth2.googleapis.com 的真实 IP，
 * 报 `dial tcp 172.253.117.95:443: i/o timeout`。
 *
 * 实测（构建了一个最小 .app 探针，用 open 启动后把 env 写进文件）：
 *   - 清空 shell 里的代理变量后启动，应用里没有任何代理变量
 *   - `launchctl setenv HTTPS_PROXY …` 之后同样方式启动，应用里就有
 * 也就是说 setenv 是**对 GUI 登录会话生效**的，跟着用户登录走，重启后失效。
 *
 * 注意它需要重新登录才能彻底清除，所以必须能一键撤销。
 */
export const SESSION_PROXY_KEYS = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "https_proxy",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
  "NO_PROXY",
  "no_proxy",
];

/** 当前用户会话里已设置的代理变量 */
export async function sessionProxyEnv() {
  const found = {};
  for (const key of SESSION_PROXY_KEYS) {
    try {
      const { stdout } = await exec("launchctl", ["getenv", key], { timeout: 5000 });
      const value = stdout.trim();
      if (value) found[key] = value;
    } catch {
      // 没有这个变量
    }
  }
  return found;
}

export async function setSessionProxyEnv(env) {
  for (const [key, value] of Object.entries(env)) {
    await exec("launchctl", ["setenv", key, String(value)], { timeout: 5000 });
  }
}

export async function clearSessionProxyEnv() {
  for (const key of SESSION_PROXY_KEYS) {
    try {
      await exec("launchctl", ["unsetenv", key], { timeout: 5000 });
    } catch {
      // 本来就没设
    }
  }
}

function guiDomain() {
  return `gui/${process.getuid?.() ?? 501}`;
}

export function plistXml({ program, args, outLog, errLog, keepAlive = true, envPath = null }) {
  const esc = (value) =>
    String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${[program, ...args].map((a) => `    <string>${esc(a)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  ${keepAlive ? "<true/>" : "<false/>"}
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${esc(envPath ?? "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${esc(outLog)}</string>
  <key>StandardErrorPath</key>
  <string>${esc(errLog)}</string>
</dict>
</plist>
`;
}

async function launchctl(args, { ignoreFailure = false } = {}) {
  try {
    return await exec("launchctl", args, { timeout: 15000 });
  } catch (err) {
    if (ignoreFailure) return { stdout: "", stderr: err.message };
    throw new Error(`launchctl ${args.join(" ")} 执行失败：${err.stderr || err.message}`);
  }
}

/**
 * bootout 之后 launchd 需要一点时间注销任务，紧接着 bootstrap 会报
 * "Bootstrap failed: 5: Input/output error"。重试几次即可，不必让用户重来。
 */
async function bootstrapWithRetry({ attempts = 15, delayMs = 600 } = {}) {
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await exec("launchctl", ["bootstrap", guiDomain(), PLIST_PATH], { timeout: 15000 });
      return;
    } catch (err) {
      lastError = err;
      const message = String(err.stderr || err.message || "");
      // 已经注册过（服务还在跑）不算失败
      if (/already bootstrapped|service already loaded/i.test(message)) return;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(
    `launchctl bootstrap 失败：${lastError?.stderr || lastError?.message || "未知错误"}`,
  );
}

export async function installService({ args = [], logDir = LOG_DIR } = {}) {
  fs.mkdirSync(logDir, { recursive: true });
  fs.mkdirSync(AGENT_DIR, { recursive: true });

  // launchd 起进程时 PATH 是空的，所以 node 必须写绝对路径。
  //
  // 但这里有个坑：直接用 process.execPath 会把「当前那次」的 node 路径写死。
  // 用 nvm 的话每次切版本路径都变，旧路径失效后 launchd 拉起来的进程直接报
  // `env: node: No such file or directory`，服务看起来装着、其实早就死了。
  //
  // 所以把 node 的固定路径也带上：nvm 的 current 软链、homebrew 的稳定路径，
  // 都写进 plist 的 PATH，这样即使 execPath 失效也还有机会找到 node。
  const program = process.execPath;
  const script = path.resolve(process.argv[1]);
  const nodeDir = path.dirname(process.execPath);
  const stableNodeDirs = [
    nodeDir,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(os.homedir(), ".nvm/current/bin"),
  ].filter((dir, i, arr) => arr.indexOf(dir) === i);
  const xml = plistXml({
    program,
    args: [script, ...args],
    outLog: path.join(logDir, "proxy.log"),
    errLog: path.join(logDir, "proxy.err.log"),
    envPath: [...stableNodeDirs, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
  });
  fs.writeFileSync(PLIST_PATH, xml, "utf8");

  await launchctl(["bootout", `${guiDomain()}/${LABEL}`], { ignoreFailure: true });
  await bootstrapWithRetry();
  await launchctl(["enable", `${guiDomain()}/${LABEL}`], { ignoreFailure: true });
  await launchctl(["kickstart", "-k", `${guiDomain()}/${LABEL}`], { ignoreFailure: true });
  return { plist: PLIST_PATH };
}

export async function uninstallService() {
  await launchctl(["bootout", `${guiDomain()}/${LABEL}`], { ignoreFailure: true });
  if (fs.existsSync(PLIST_PATH)) fs.unlinkSync(PLIST_PATH);
  // 服务没了，登录会话里的代理变量也一起撤掉 —— 否则应用会指向一个
  // 已经不存在的端口，表现为「所有外网都连不上」，比不设更难排查。
  await clearSessionProxyEnv();
  return { plist: PLIST_PATH };
}

/**
 * 启动已安装的服务。
 * bootout 会把任务从 launchd 里彻底注销，这时直接 kickstart 会失败，
 * 所以先尝试 bootstrap（已注册时它会报错，忽略即可）。
 */
export async function startService({ port = 8899, timeoutMs = 10000 } = {}) {
  if (!fs.existsSync(PLIST_PATH)) {
    throw new Error("转发服务还没安装，请先运行 tunless service install");
  }
  // 已注册时 bootstrap 会失败，这是正常情况，所以允许失败
  await bootstrapWithRetry({ attempts: 2, delayMs: 200 }).catch(() => {});
  await launchctl(["enable", `${guiDomain()}/${LABEL}`], { ignoreFailure: true });
  await launchctl(["kickstart", "-k", `${guiDomain()}/${LABEL}`]);
  // launchd 拉起进程需要几百毫秒到几秒，端口没起来就刷新界面会显示「未运行」。
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await sidecarReachable("127.0.0.1", port, 500)) return serviceStatus();
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return serviceStatus();
}

/**
 * 重启服务，让新的上游代理设置生效。
 *
 * 只 kickstart 是不够的：常驻进程在启动时就把上游端口读进内存了，
 * 必须真的换成新进程。先 bootout 再 bootstrap，端口才会重新读一次。
 */
export async function restartService({ port = 8899, timeoutMs = 15000 } = {}) {
  await stopService({ timeoutMs: 5000 });
  return startService({ port, timeoutMs });
}

/** 停止服务，并等到任务真的从 launchd 里消失，避免界面读到过期的 pid。 */
export async function stopService({ timeoutMs = 5000 } = {}) {
  await launchctl(["bootout", `${guiDomain()}/${LABEL}`], { ignoreFailure: true });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await serviceStatus();
    if (!status.running) return status;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return serviceStatus();
}

export async function serviceStatus() {
  const { stdout } = await launchctl(["print", `${guiDomain()}/${LABEL}`], { ignoreFailure: true });
  const installed = fs.existsSync(PLIST_PATH);
  const running = /state = running/.test(stdout);
  const pidMatch = /pid = (\d+)/.exec(stdout);
  return {
    installed,
    running,
    pid: pidMatch ? Number(pidMatch[1]) : null,
    plist: PLIST_PATH,
  };
}

/**
 * 转发服务是否真的在提供代理：launchd 里的状态可能滞后，
 * 端口能连上才算数。
 */
export async function sidecarReachable(host, port, timeoutMs = 800) {
  const net = await import("node:net");
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}
export function readServiceLog(lines = 20, logDir = LOG_DIR) {
  const file = path.join(logDir, "proxy.log");
  if (!fs.existsSync(file)) return "";
  const text = fs.readFileSync(file, "utf8").split("\n");
  return text.slice(-lines).join("\n");
}
