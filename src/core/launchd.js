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
  await launchctl(["bootstrap", guiDomain(), PLIST_PATH]);
  await launchctl(["enable", `${guiDomain()}/${LABEL}`], { ignoreFailure: true });
  await launchctl(["kickstart", "-k", `${guiDomain()}/${LABEL}`], { ignoreFailure: true });
  return { plist: PLIST_PATH };
}

export async function uninstallService() {
  await launchctl(["bootout", `${guiDomain()}/${LABEL}`], { ignoreFailure: true });
  if (fs.existsSync(PLIST_PATH)) fs.unlinkSync(PLIST_PATH);
  return { plist: PLIST_PATH };
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

export function readServiceLog(lines = 20, logDir = LOG_DIR) {
  const file = path.join(logDir, "proxy.log");
  if (!fs.existsSync(file)) return "";
  const text = fs.readFileSync(file, "utf8").split("\n");
  return text.slice(-lines).join("\n");
}
