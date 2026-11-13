import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import { listProcesses } from "./discover.js";

const exec = promisify(execFile);

// Go's net/http honours HTTPS_PROXY through this package. Its presence in a
// binary means the program can be pointed at a proxy via environment variable.
const PROXY_SYMBOL = "golang.org/x/net/http/httpproxy";
const PROXY_ENV_SYMBOL = "HTTPS_PROXY";

// Electron 主二进制 150MB+，grep -a 扫一遍也要好几秒。再大的跳过。
const MAX_BINARY_SIZE = 200 * 1024 * 1024;

const INTERESTING = [
  "Antigravity", "language_server", "Codex", "Cursor", "Claude", "ChatGPT",
  "Gemini", "Qoder", "DeepSeek", "ZCode", "WorkBuddy", "OpenCode", "Grok",
  "Kiro", "CodeBuddy", "Warp", "Docker", "node", "python3", "java",
];

export async function binarySupportsProxyEnv(binaryPath) {
  if (!binaryPath) return null;
  try {
    const stat = fs.statSync(binaryPath);
    if (!stat.isFile() || stat.size > MAX_BINARY_SIZE) return null;
    // grep -a 直接扫二进制就行，不必先过一遍 strings ——
    // strings 要把整个文件逐字节重扫一遍再喂给 grep，两倍开销。
    const { stdout } = await exec(
      "grep",
      ["-ac", "-m1", "-e", PROXY_SYMBOL, "-e", PROXY_ENV_SYMBOL, binaryPath],
      { timeout: 15000, maxBuffer: 1024 * 1024 },
    );
    const count = Number(stdout.trim() || "0");
    return count > 0;
  } catch {
    return null;
  }
}

export function isInteresting(comm) {
  return INTERESTING.some((needle) => comm.toLowerCase().includes(needle.toLowerCase()));
}

export async function inspectProcesses({ concurrency = 4 } = {}) {
  const procs = await listProcesses();
  const seen = new Map();
  const targets = [];

  for (const p of procs) {
    const needle = p.comm || p.command || "";
    if (!isInteresting(needle)) continue;
    if (seen.has(needle)) continue;
    seen.set(needle, true);
    targets.push(p);
  }

  // 逐进程串行扫二进制是最慢的一步（每个最多 15s）。限并发 4 批跑。
  const results = new Array(targets.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < targets.length) {
      const index = cursor;
      cursor += 1;
      const p = targets[index];
      const supports = await binarySupportsProxyEnv(p.binary);
      results[index] = {
        pid: p.pid,
        comm: p.comm,
        binary: p.binary,
        supportsProxyEnv: supports,
        status: supports === null ? "unknown" : supports ? "supported" : "unsupported",
      };
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, targets.length) }, worker));
  return results;
}

export async function processesWithDirectConnections(pids) {
  const out = [];
  for (const pid of pids) {
    try {
      const { stdout } = await exec("lsof", ["-nP", "-iTCP", "-a", "-p", String(pid)], {
        timeout: 8000,
        maxBuffer: 1024 * 1024,
      });
      const lines = stdout.split("\n").slice(1);
      const external = lines
        .map((l) => l.trim().split(/\s+/))
        .filter((cols) => cols.length >= 9)
        .filter((cols) => cols[8] && /ESTABLISHED|SYN_SENT/.test(cols[8] || ""))
        .map((cols) => ({ remote: cols[cols.length - 1], state: cols[cols.length - 2] }))
        .filter((c) => c.remote && !c.remote.startsWith("127.0.0.1"));
      if (external.length) out.push({ pid, connections: external });
    } catch {
      // lsof may fail without privileges; skip silently
    }
  }
  return out;
}

export function proxyAdvice(entry) {
  if (entry.status === "supported") {
    return `支持 HTTPS_PROXY — 用 HTTPS_PROXY=http://127.0.0.1:<混合端口> 启动它即可走代理。`;
  }
  if (entry.status === "unsupported") {
    return `不读取 HTTPS_PROXY — 需要开启 TUN 模式（或为它单独配置 SOCKS 代理）才能访问代理网络。`;
  }
  return `无法确定该程序是否支持代理环境变量。`;
}
