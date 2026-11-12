// Turns a set of observed internal hostnames into a mihomo DNS configuration.
//
// Strategy: collapse concrete hosts into their registrable-ish suffix so that
// future subdomains are covered automatically. e.g. matrix.17usoft.com and
// git.17usoft.com collapse to 17usoft.com, but cdb.17usoft.com is kept
// separately because it is a distinct delegation whose own subdomains
// (cn-north.database-mysql.qa.cdb.17usoft.com) live even deeper.

// Multi-label public suffixes we understand. Anything else uses the last two
// labels as the registrable domain (17usoft.com, 17u.cn, example.io).
const MULTI_SUFFIXES = new Set([
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn", "ac.cn",
  "co.uk", "org.uk", "ac.uk", "com.hk", "com.tw", "com.mo",
  "co.jp", "ne.jp", "or.jp", "com.au", "com.br", "co.in",
]);

function stripQuotes(value) {
  const v = String(value).trim();
  if (v.length > 1 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}

export function registrableSuffix(host, extraSuffixes = []) {
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 1) return host;

  const matched = extraSuffixes.find(
    (s) => host === s || host.endsWith(`.${s}`),
  );
  if (matched) return matched;

  const lastTwo = parts.slice(-2).join(".");
  if (MULTI_SUFFIXES.has(lastTwo) && parts.length >= 3) {
    return parts.slice(-3).join(".");
  }
  return lastTwo;
}

// Collapse concrete hosts into suffix wildcards.
//
// - Hosts that share a registrable domain collapse to that domain, so
//   matrix.17usoft.com + git.17usoft.com + a.b.17usoft.com => 17usoft.com.
// - When the registrable domain itself was observed, deeper hosts are kept as
//   their own sub-delegation (cdb.17usoft.com), because a distinct zone lives
//   there and may need its own DNS decision.
export function mergeHosts(hosts, extraSuffixes = []) {
  const all = [...new Set(hosts.filter(Boolean))];
  const hostSet = new Set(all);

  const out = new Set();
  for (const host of all) {
    const base = registrableSuffix(host, extraSuffixes);
    if (host === base) {
      out.add(base);
      continue;
    }
    if (hostSet.has(base)) {
      const parts = host.split(".");
      out.add(parts.length >= 3 ? parts.slice(-3).join(".") : base);
      continue;
    }
    out.add(base);
  }
  return [...out].sort();
}

// A host is "internal" when it resolves to an RFC1918 private address.
// fake-ip (198.18.0.0/16) means the domain still needs a fake-ip-filter entry
// so it resolves for real instead of being handed a synthetic address.
export function partitionByKind(results) {
  const internal = [];
  const fake = [];
  const publicHosts = [];
  const unresolved = [];

  for (const r of results) {
    if (!r.ok) {
      unresolved.push(r);
    } else if (r.kind === "internal") {
      internal.push(r);
    } else if (r.kind === "fake") {
      fake.push(r);
    } else if (r.kind === "nxdomain") {
      unresolved.push(r);
    } else {
      publicHosts.push(r);
    }
  }
  return { internal, fake, publicHosts, unresolved };
}

export function buildDnsSection({
  internalDns,
  internalSuffixes = [],
  publicDns = ["223.5.5.5", "119.29.29.29", "114.114.114.114"],
  existing = {},
}) {
  const nameserver = [...new Set([...(existing.nameserver || []), ...publicDns])];
  if (internalDns && !nameserver.includes(internalDns)) nameserver.push(internalDns);

  const policy = {};
  for (const [key, value] of Object.entries(existing["nameserver-policy"] || {})) {
    policy[stripQuotes(key)] = value;
  }
  const filter = (existing["fake-ip-filter"] || []).map((item) => stripQuotes(item));

  for (const suffix of internalSuffixes) {
    policy[suffix] = [internalDns];
    const entry = `+.${suffix}`;
    if (!filter.includes(entry)) filter.push(entry);
  }

  const dns = { ...existing };
  dns.nameserver = nameserver;
  dns["nameserver-policy"] = policy;
  dns["fake-ip-filter"] = filter;
  return dns;
}

export function diffLines(before, after) {
  const beforeLines = before ? before.split("\n") : [];
  const afterLines = after ? after.split("\n") : [];
  const beforeSet = new Map();
  for (const line of beforeLines) beforeSet.set(line, (beforeSet.get(line) || 0) + 1);
  const afterSet = new Map();
  for (const line of afterLines) afterSet.set(line, (afterSet.get(line) || 0) + 1);

  const added = [];
  const removed = [];
  for (const [line, count] of afterSet) {
    const prev = beforeSet.get(line) || 0;
    if (count > prev) added.push({ line, count: count - prev });
  }
  for (const [line, count] of beforeSet) {
    const next = afterSet.get(line) || 0;
    if (count > next) removed.push({ line, count: count - next });
  }
  return { added, removed };
}

export function renderDiff(before, after) {
  const { added, removed } = diffLines(before, after);
  const out = [];
  for (const item of removed) {
    for (let i = 0; i < item.count; i++) out.push(`- ${item.line}`);
  }
  for (const item of added) {
    for (let i = 0; i < item.count; i++) out.push(`+ ${item.line}`);
  }
  return out.join("\n");
}
