// 用户手动补充的分流规则。
//
// 自动扫描只能看到「本机曾经用过、且解析到私网地址」的域名，覆盖不到用户在
// 别的机器/别的同事那里才知道的内网地址。这里允许用户直接写三类东西：
//
//   domain   matrix.17usoft.com   按后缀匹配，子域名自动覆盖
//   keyword  jira                 域名里含这个词就算内网
//   cidr     10.0.0.0/8           解析出来的 IP 落在段内就算内网
//
// 规则存在 ~/.tunless/rules.json，转发服务每次启动时读取，改完重装/重启服务即可生效。

import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./paths.js";

export const RULE_KINDS = ["domain", "keyword", "cidr"];

export function rulesFile() {
  return path.join(dataDir(), "rules.json");
}

const HOST_RE = /^[a-zA-Z0-9*+_.-]+$/;
const CIDR_RE = /^(\d{1,3}(?:\.\d{1,3}){3})(?:\/(\d{1,2}))?$/;

export function ipToInt(ip) {
  const parts = String(ip).trim().split(".");
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    value = value * 256 + n;
  }
  return value >>> 0;
}

/** 解析 10.0.0.0/8 这类网段；不写掩码时按单台主机处理 */
export function parseCidr(value) {
  const m = CIDR_RE.exec(String(value).trim());
  if (!m) return null;
  const base = ipToInt(m[1]);
  if (base === null) return null;
  const bits = m[2] === undefined ? 32 : Number(m[2]);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (base & mask) >>> 0, mask, bits };
}

export function ipInCidr(ip, cidr) {
  const value = typeof ip === "string" ? ipToInt(ip) : ip;
  if (value === null) return false;
  return ((value & cidr.mask) >>> 0) === cidr.base;
}

/**
 * 把用户输入归一成一条规则。
 * 返回 { kind, value } 或抛出带中文说明的错误。
 */
export function normalizeRule(raw, kindHint) {
  const input = String(raw ?? "").trim().replace(/^\+\./, "").replace(/^\*\./, "");
  if (!input) throw new Error("规则不能为空");

  if (kindHint === "cidr" || (!kindHint && CIDR_RE.test(input))) {
    const cidr = parseCidr(input);
    if (!cidr) throw new Error(`不是合法的 IP 段：${input}（示例 10.0.0.0/8 或 10.1.2.3）`);
    return { kind: "cidr", value: input };
  }

  if (kindHint === "keyword") {
    if (/\s/.test(input)) throw new Error("关键词不能包含空格");
    return { kind: "keyword", value: input.toLowerCase() };
  }

  if (!input.includes(".")) {
    // 不含点、也不像 IP 的，多半是用户想写关键词
    return normalizeRule(input, "keyword");
  }
  if (!HOST_RE.test(input)) {
    throw new Error(`不是合法的域名：${input}（只允许字母、数字、- . * +）`);
  }
  return { kind: "domain", value: input.toLowerCase() };
}

export function emptyRules() {
  return { domain: [], keyword: [], cidr: [] };
}

export function loadRules(file = rulesFile()) {
  if (!fs.existsSync(file)) return emptyRules();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const out = emptyRules();
    for (const kind of RULE_KINDS) {
      const list = Array.isArray(parsed?.[kind]) ? parsed[kind] : [];
      out[kind] = [...new Set(list.map((v) => String(v).trim()).filter(Boolean))];
    }
    return out;
  } catch {
    // 文件坏了不该让整个工具起不来
    return emptyRules();
  }
}

export function saveRules(rules, file = rulesFile()) {
  const out = emptyRules();
  for (const kind of RULE_KINDS) {
    out[kind] = [...new Set((rules?.[kind] ?? []).map((v) => String(v).trim()).filter(Boolean))];
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  return out;
}

/** 追加一条规则，已存在则原样返回 */
export function addRule(rules, raw, kindHint) {
  const { kind, value } = normalizeRule(raw, kindHint);
  const next = { ...emptyRules(), ...rules };
  next[kind] = [...new Set([...(next[kind] ?? []), value])];
  return { rules: next, rule: { kind, value }, added: !(rules?.[kind] ?? []).includes(value) };
}

export function removeRule(rules, raw, kindHint) {
  const { kind, value } = normalizeRule(raw, kindHint);
  const next = { ...emptyRules(), ...rules };
  const before = next[kind] ?? [];
  next[kind] = before.filter((v) => v !== value);
  return { rules: next, rule: { kind, value }, removed: before.length !== next[kind].length };
}

export function totalRules(rules) {
  return RULE_KINDS.reduce((sum, kind) => sum + (rules?.[kind]?.length ?? 0), 0);
}

/** 规则里的域名可以直接当内网后缀用 */
export function ruleSuffixes(rules) {
  return [...new Set(rules?.domain ?? [])].sort();
}

export function ruleKeywords(rules) {
  return [...new Set(rules?.keyword ?? [])];
}

export function ruleCidrs(rules) {
  return (rules?.cidr ?? []).map((raw) => ({ raw, ...parseCidr(raw) })).filter((c) => c.mask !== undefined);
}

/**
 * 域名命中规则吗？
 * 返回 "domain" / "keyword" / null，方便界面告诉用户「这条为什么走直连」。
 */
export function matchHostRules(host, rules) {
  const h = String(host ?? "").toLowerCase().replace(/\.$/, "");
  if (!h) return null;
  for (const suffix of rules?.domain ?? []) {
    if (h === suffix || h.endsWith(`.${suffix}`)) return "domain";
  }
  for (const keyword of rules?.keyword ?? []) {
    if (keyword && h.includes(keyword)) return "keyword";
  }
  return null;
}

/** 解析出来的 IP 命中用户填的网段吗？ */
export function matchIpRules(ip, rules) {
  for (const cidr of ruleCidrs(rules)) {
    if (ipInCidr(ip, cidr)) return cidr.raw;
  }
  return null;
}
