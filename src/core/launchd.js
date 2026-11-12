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

function guiDomain() {
  return `gui/${process.getuid?.() ?? 501}`;
}

export function plistXml({ program, args, outLog, errLog, keepAlive = true }) {
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

  // launchd starts jobs with a bare PATH, so the node binary has to be
  // addressed by absolute path and the script passed as an argument.
  const program = process.execPath;
  const script = path.resolve(process.argv[1]);
  const xml = plistXml({
    program,
    args: [script, ...args],
    outLog: path.join(logDir, "proxy.log"),
    errLog: path.join(logDir, "proxy.err.log"),
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
