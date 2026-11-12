import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const home = os.homedir();

const DOMAIN_RE = /\b([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*\.[a-zA-Z]{2,})\b/g;

const IGNORED_TLD = new Set([
  "js", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "c", "h", "cc",
  "cpp", "hpp", "sh", "bash", "zsh", "md", "txt", "json", "yaml", "yml",
  "toml", "ini", "cfg", "conf", "log", "lock", "png", "jpg", "jpeg", "gif",
  "svg", "css", "html", "xml", "csv", "sql", "zip", "tar", "gz", "exe",
  "dll", "so", "dylib", "app", "dmg", "pkg", "mp4", "mp3", "wav", "woff",
  "woff2", "ttf", "eot", "map", "min", "d", "php", "vue", "swift", "kt",
]);

const STATIC_TLDS = new Set([
  "com", "cn", "net", "org", "io", "dev", "co", "me", "cn", "edu", "gov",
  "mil", "int", "info", "biz", "name", "pro", "xyz", "top", "site", "online",
]);

export function extractDomains(text) {
  if (!text) return [];
  const found = new Set();
  for (const m of text.matchAll(DOMAIN_RE)) {
    const host = m[1].toLowerCase().replace(/\.$/, "");
    if (!host.includes(".")) continue;
    const tld = host.split(".").pop();
    if (IGNORED_TLD.has(tld)) continue;
    if (host.length > 253) continue;
    found.add(host);
  }
  return [...found];
}

function readTextSafe(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch (err) {
    if (err.code === "EACCES" || err.code === "EPERM") return { error: "permission-denied" };
    return null;
  }
}

export function scanShellHistory() {
  const sources = [];
  const hosts = new Set();
  const notes = [];

  for (const file of [".zsh_history", ".bash_history"]) {
    const p = path.join(home, file);
    if (!fs.existsSync(p)) continue;
    const text = readTextSafe(p);
    if (text === null) {
      notes.push(`${file}: 无法读取`);
      continue;
    }
    if (typeof text === "object") {
      notes.push(`${file}: 权限不足`);
      continue;
    }
    for (const d of extractDomains(text)) hosts.add(d);
    sources.push(file);
  }

  return { hosts: [...hosts], sources, notes };
}

export function scanClashLogs(logDir) {
  if (!logDir || !fs.existsSync(logDir)) return { hosts: [], sources: [], notes: [] };
  const hosts = new Set();
  const files = [];
  let entries = [];
  try {
    entries = fs.readdirSync(logDir).filter((f) => f.endsWith(".log"));
  } catch {
    return { hosts: [], sources: [], notes: [`${logDir}: 无法读取`] };
  }
  for (const f of entries.slice(-10)) {
    const text = readTextSafe(path.join(logDir, f));
    if (typeof text === "string") {
      for (const d of extractDomains(text)) hosts.add(d);
    }
  }
  if (entries.length) files.push(`clash-logs(${entries.length})`);
  return { hosts: [...hosts], sources: files, notes: [] };
}

export async function scanRepos(roots, { maxBytes = 40 * 1024 * 1024 } = {}) {
  const hosts = new Set();
  const sources = [];
  const notes = [];

  for (const root of roots) {
    if (!root || !fs.existsSync(root)) continue;
    let collected = 0;
    try {
      const { stdout } = await exec(
        "rg",
        [
          "--no-messages",
          "--no-heading",
          "--max-filesize", "2M",
          "--max-count", "200",
          "-o",
          "-r", "$0",
          "-e", "[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*\\.[a-zA-Z]{2,}",
          root,
        ],
        { maxBuffer: maxBytes, timeout: 20000 },
      );
      for (const d of extractDomains(stdout)) hosts.add(d);
      sources.push(root);
    } catch (err) {
      if (err.code === "ENOENT") {
        notes.push(`${root}: 未安装 rg，已跳过`);
      } else {
        notes.push(`${root}: 扫描失败（${err.code || err.message}）`);
      }
    }
  }
  return { hosts: [...hosts], sources, notes };
}

export function scanChromeHistory() {
  const p = path.join(
    home,
    "Library/Application Support/Google/Chrome/Default/History",
  );
  if (!fs.existsSync(p)) return { hosts: [], sources: [], notes: [] };
  const text = readTextSafe(p);
  if (text === null) {
    return {
      hosts: [],
      sources: [],
      notes: [
        "chrome-history: 权限不足 — 请给终端授予「完全磁盘访问权限」以获取更完整的域名列表",
      ],
    };
  }
  if (typeof text === "object") {
    return {
      hosts: [],
      sources: [],
      notes: ["chrome-history: 权限不足 — 请给终端授予「完全磁盘访问权限」以获取更完整的域名列表"],
    };
  }
  const hosts = new Set();
  for (const d of extractDomains(text)) hosts.add(d);
  return { hosts: [...hosts], sources: ["chrome-history"], notes: [] };
}

export async function scanAll({ repoRoots = [], includeChrome = true } = {}) {
  const shell = scanShellHistory();
  const clash = scanClashLogs(shell.clashLogDir);
  const chrome = includeChrome ? scanChromeHistory() : { hosts: [], sources: [], notes: [] };
  const repos = await scanRepos(repoRoots);

  const byHost = new Map();
  const add = (host, source) => {
    if (!byHost.has(host)) byHost.set(host, new Set());
    byHost.get(host).add(source);
  };
  for (const h of shell.hosts) add(h, "shell-history");
  for (const h of clash.hosts) add(h, "clash-logs");
  for (const h of chrome.hosts) add(h, "chrome-history");
  for (const h of repos.hosts) add(h, "repos");

  return {
    hosts: [...byHost.entries()].map(([host, sources]) => ({ host, sources: [...sources] })),
    sources: [...shell.sources, ...clash.sources, ...chrome.sources, ...repos.sources],
    notes: [...shell.notes, ...clash.notes, ...chrome.notes, ...repos.notes],
  };
}
