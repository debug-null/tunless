import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const home = os.homedir();

export const VERGE_DIR = path.join(
  home,
  "Library/Application Support/io.github.clash-verge-rev.clash-verge-rev",
);

// 其他 mihomo 系客户端的配置目录。它们的 API 也能连，只是
// 「写 DNS 分流」这一步没有 Verge 那种 merge 增强文件可写。
export const MIHOMO_PARTY_DIR = path.join(
  home,
  "Library/Application Support/mihomo-party",
);

export function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function readFileSafe(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

export function parsePort(text, key) {
  const m = new RegExp(`^${key}:\\s*(\\d+)`, "m").exec(text);
  return m ? Number(m[1]) : null;
}

export function parseSecret(text) {
  const m = /^secret:\s*(.+)$/m.exec(text);
  return m ? m[1].trim() : "";
}

export function parseTopLevelFlags(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = /^([a-zA-Z_][\w-]*):\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

export function unixSocketCandidates() {
  const uid = process.getuid?.() ?? 501;
  const candidates = [
    path.join("/var/run/clash-verge-service/users", String(uid), "verge-mihomo.sock"),
    path.join("/var/run/clash-verge-service", "verge-mihomo.sock"),
    path.join(os.tmpdir(), "verge-mihomo.sock"),
  ];
  return candidates.filter(exists);
}

export function findCurrentProfile(text) {
  const cur = /^current:\s*(\S+)/m.exec(text);
  if (!cur) return null;
  const uid = cur[1];
  const escaped = uid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const item = new RegExp(`- uid: ${escaped}\\n([\\s\\S]*?)(?=\\n- uid:|$)`).exec(text);
  return { uid, body: item ? item[1] : "" };
}

export function discoverVerge() {
  if (!exists(VERGE_DIR)) return null;

  const vergeText = readFileSafe(path.join(VERGE_DIR, "verge.yaml")) ?? "";
  const verge = parseTopLevelFlags(vergeText);
  const configText = readFileSafe(path.join(VERGE_DIR, "config.yaml")) ?? "";

  const controllerPort = parsePort(configText, "external-controller") ?? 9097;
  const secret = parseSecret(configText);
  const mixedPort = parsePort(configText, "mixed-port") ?? 7897;

  const apiCandidates = unixSocketCandidates().map((socketPath) => ({ socketPath }));
  apiCandidates.push({ host: "127.0.0.1", port: controllerPort, secret });

  let currentProfileUid = null;
  let mergeFile = null;
  let rulesFile = null;
  const profilesText = readFileSafe(path.join(VERGE_DIR, "profiles.yaml"));
  if (profilesText) {
    const profile = findCurrentProfile(profilesText);
    if (profile) {
      currentProfileUid = profile.uid;
      const merge = /\n\s+merge:\s*(\S+)/.exec(profile.body);
      const rules = /\n\s+rules:\s*(\S+)/.exec(profile.body);
      if (merge) mergeFile = path.join(VERGE_DIR, "profiles", `${merge[1]}.yaml`);
      if (rules) rulesFile = path.join(VERGE_DIR, "profiles", `${rules[1]}.yaml`);
    }
  }

  return {
    id: "clash-verge-rev",
    label: "Clash Verge Rev",
    home: VERGE_DIR,
    apiCandidates,
    controllerPort,
    secret,
    mixedPort,
    tunEnabled: verge.enable_tun_mode === "true",
    systemProxyEnabled: verge.enable_system_proxy === "true",
    currentProfileUid,
    mergeFile,
    rulesFile,
    generatedConfig: path.join(VERGE_DIR, "clash-verge.yaml"),
    logDir: path.join(VERGE_DIR, "logs"),
    profilesDir: path.join(VERGE_DIR, "profiles"),
  };
}

export function discoverGeneric() {
  const candidates = [];
  const known = [
    path.join(home, ".config/mihomo/config.yaml"),
    path.join(home, ".config/clash/config.yaml"),
    path.join(MIHOMO_PARTY_DIR, "mihomo.yaml"),
    path.join(MIHOMO_PARTY_DIR, "config.yaml"),
  ];
  for (const file of known) {
    if (!exists(file)) continue;
    // mihomo-party 的目录里既有内核参数也有应用自身的设置，后者没有端口、
    // 只有 UI 偏好。往里写 dns 段会把客户端配置搞坏，所以必须验证这确实是
    // 一份内核配置（含 mixed-port / port / proxies 之类的字段）。
    const text = readFileSafe(file) ?? "";
    if (!looksLikeClashConfig(text)) continue;
    candidates.push(file);
  }

  const apiCandidates = [{ host: "127.0.0.1", port: 9090, secret: "" }];
  for (const cfg of candidates) {
    const text = readFileSafe(cfg) ?? "";
    // mihomo-party 把内核参数写在 mihomo.yaml，应用设置写在 config.yaml；
    // 两个都读一遍，谁身上有端口就用谁。
    const port = parsePort(text, "external-controller") ?? parsePort(text, "external-controller-tls");
    if (port) apiCandidates.unshift({ host: "127.0.0.1", port, secret: parseSecret(text) });
  }

  return {
    id: "generic-mihomo",
    label: "Generic mihomo",
    home: path.dirname(candidates[0] ?? home),
    apiCandidates,
    configFiles: candidates,
    configFile: candidates[0] ?? null,
    mixedPort: null,
  };
}

export function looksLikeClashConfig(text) {
  if (!text || text.trim().length < 16) return false;
  return /^(mixed-port|port|socks-port|external-controller|proxies|proxy-groups|proxy-providers)\s*:/m.test(
    text,
  );
}

export function discoverAll() {
  const found = [];
  const verge = discoverVerge();
  if (verge) found.push(verge);
  found.push(discoverGeneric());
  return found;
}

export async function listProcesses() {
  try {
    const { stdout } = await exec("ps", ["-eo", "pid=,comm="]);
    return stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const idx = line.indexOf(" ");
        return { pid: Number(line.slice(0, idx)), comm: line.slice(idx + 1) };
      })
      .filter((p) => Number.isFinite(p.pid));
  } catch {
    return [];
  }
}

export async function systemProxyState() {
  try {
    const { stdout } = await exec("scutil", ["--proxy"]);
    const read = (key) => {
      const m = new RegExp(`${key}\\s*:\\s*(\\S+)`).exec(stdout);
      return m ? m[1] : null;
    };
    return {
      httpEnabled: read("HTTPEnable") === "1",
      httpsEnabled: read("HTTPSEnable") === "1",
      host: read("HTTPProxy"),
      port: read("HTTPPort"),
    };
  } catch {
    return null;
  }
}
