import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { probeApi } from "./core/api.js";
import { discoverAll, systemProxyState } from "./core/discover.js";
import { classifyDomain } from "./core/dns.js";
import { scanAll } from "./core/scan.js";
import { inspectProcesses, proxyAdvice } from "./core/proc.js";
import {
  partitionByKind,
  mergeHosts,
  buildDnsSection,
  renderDiff,
} from "./core/plan.js";
import { dumpYaml } from "./core/yaml.js";
import { VergeAdapter } from "./adapters/verge.js";
import { GenericAdapter } from "./adapters/generic.js";

const DEFAULT_INTERNAL_DNS = "10.249.150.130";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

const color = process.stdout.isTTY && !process.env.NO_COLOR;
function paint(code, text) {
  return color ? `${code}${text}${C.reset}` : text;
}
const ok = (t) => paint(C.green + C.bold, `✔ ${t}`);
const warn = (t) => paint(C.yellow + C.bold, `⚠ ${t}`);
const bad = (t) => paint(C.red + C.bold, `✖ ${t}`);
const info = (t) => paint(C.cyan, `• ${t}`);
const head = (t) => paint(C.bold, t);
const dim = (t) => paint(C.dim, t);

export function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        args.flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const next = argv[i + 1];
        if (next && !next.startsWith("--")) {
          args.flags[a.slice(2)] = next;
          i += 1;
        } else {
          args.flags[a.slice(2)] = true;
        }
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}

function resolveAdapter(frontend) {
  if (frontend.id === "clash-verge-rev") return new VergeAdapter(frontend);
  return new GenericAdapter(frontend);
}

async function pickFrontend(flags) {
  const frontends = discoverAll();
  const explicit = flags.frontend;
  if (explicit) {
    const found = frontends.find((f) => f.id === explicit || f.label === explicit);
    if (!found) throw new Error(`unknown frontend: ${explicit}`);
    return found;
  }
  for (const f of frontends) {
    if (f.id === "clash-verge-rev" && fs.existsSync(f.home)) return f;
  }
  return frontends[frontends.length - 1];
}

async function connect(frontend) {
  return probeApi(frontend.apiCandidates);
}

function backendDir() {
  return path.join(os.homedir(), ".netfix");
}

function backupDir() {
  return path.join(backendDir(), "backups", new Date().toISOString().replace(/[:.]/g, "-"));
}

async function probeDomains(hosts, internalDns, concurrency = 8) {
  const results = [];
  const queue = [...hosts];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const host = queue.shift();
      results.push(await classifyDomain(host, internalDns));
    }
  });
  await Promise.all(workers);
  return results;
}

export async function cmdScan(args) {
  const internalDns = args.flags["internal-dns"] || DEFAULT_INTERNAL_DNS;
  const repoRoots = args.flags.repos
    ? String(args.flags.repos).split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const includeChrome = args.flags["no-chrome"] !== true;

  const scanned = await scanAll({ repoRoots, includeChrome });
  const hosts = scanned.hosts.map((h) => h.host);

  console.log(head(`\nScanned ${hosts.length} candidate hosts`));
  console.log(dim(`  sources: ${scanned.sources.join(", ") || "none"}`));
  for (const note of scanned.notes) console.log(warn(`  ${note}`));

  const results = await probeDomains(hosts, internalDns);
  const { internal, fake, publicHosts, unresolved } = partitionByKind(results);

  console.log(head(`\n${head("Internal")} (private IP — ${internal.length})`));
  for (const r of internal.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(`  ${ok(r.name.padEnd(50))} ${dim(r.ips.join(", "))}`);
  }
  console.log(head(`\n${head("Fake-IP")} (needs filter — ${fake.length})`));
  for (const r of fake.slice(0, 20)) {
    console.log(`  ${warn(r.name.padEnd(50))} ${dim(r.ips.join(", "))}`);
  }
  console.log(head(`\n${head("Public")} (${publicHosts.length}) — shown truncated`));
  console.log(dim(`  ${publicHosts.slice(0, 10).map((r) => r.name).join(", ")}`));
  if (unresolved.length) {
    console.log(head(`\n${head("Unresolved")} (${unresolved.length})`));
    for (const r of unresolved.slice(0, 10)) console.log(`  ${dim(r.name)} — ${r.error}`);
  }
  console.log();
  return 0;
}

export async function cmdDoctor(args) {
  const internalDns = args.flags["internal-dns"] || DEFAULT_INTERNAL_DNS;
  let exitCode = 0;

  console.log(head("\n── Environment ──"));
  const frontends = discoverAll();
  const frontend = await pickFrontend(args);
  console.log(`  ${info(`frontend: ${frontend.label}`)}`);

  let api = null;
  try {
    const conn = await connect(frontend);
    api = conn.api;
    console.log(`  ${ok(`mihomo API reachable (${conn.api.descriptor})`)}`);
    console.log(dim(`    version: ${conn.info.version}`));
  } catch (err) {
    exitCode = 1;
    console.log(`  ${bad("mihomo API not reachable")}`);
    for (const f of err.failures ?? []) {
      console.log(dim(`    ${f.candidate.socketPath ? `unix://${f.candidate.socketPath}` : `http://${f.candidate.host}:${f.candidate.port}`}: ${f.error}`));
    }
    console.log(dim("    start your proxy client, then re-run netfix doctor"));
  }

  if (api) {
    try {
      const cfg = await api.configs();
      const tun = cfg.tun?.enable;
      console.log(`  ${tun ? ok("TUN mode enabled") : warn("TUN mode disabled")}`);
      if (!tun) {
        console.log(dim("    programs that ignore system proxy cannot reach proxied networks without TUN"));
      }
      const mode = cfg.mode;
      console.log(`  ${info(`rule mode: ${mode}`)}`);
    } catch (err) {
      exitCode = 1;
      console.log(`  ${bad(`could not read core config: ${err.message}`)}`);
    }
  }

  const sysProxy = await systemProxyState();
  if (sysProxy) {
    const enabled = sysProxy.httpEnabled && sysProxy.httpsEnabled;
    console.log(`  ${enabled ? ok("system proxy enabled") : warn("system proxy disabled")} ${dim(`${sysProxy.host}:${sysProxy.port}`)}`);
  }

  if (frontend.id === "clash-verge-rev") {
    console.log(`  ${frontend.mergeFile ? ok("merge enhancement file located") : warn("no merge enhancement file")}`);
    if (frontend.mergeFile) console.log(dim(`    ${frontend.mergeFile}`));
    console.log(`  ${frontend.tunEnabled ? ok("verge enable_tun_mode=true") : warn("verge enable_tun_mode=false")}`);
  }

  console.log(head("\n── Program proxy capability ──"));
  const procs = await inspectProcesses();
  if (!procs.length) {
    console.log(dim("  no interesting processes detected"));
  }
  for (const p of procs) {
    const badge =
      p.status === "supported"
        ? ok("proxy-env supported")
        : p.status === "unsupported"
          ? warn("proxy-env UNSUPPORTED")
          : dim("proxy-env unknown");
    console.log(`  ${String(p.pid).padEnd(7)} ${p.comm.slice(0, 52).padEnd(52)} ${badge}`);
    if (p.status === "unsupported") console.log(dim(`      ${proxyAdvice(p)}`));
  }

  console.log(head("\n── Internal domains ──"));
  const repoRoots = args.flags.repos
    ? String(args.flags.repos).split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const scanned = await scanAll({ repoRoots, includeChrome: args.flags["no-chrome"] !== true });
  const results = await probeDomains(scanned.hosts.map((h) => h.host), internalDns);
  const { internal, fake } = partitionByKind(results);

  console.log(`  ${info(`${internal.length} internal domain(s) resolve to private IPs`)}`);
  console.log(`  ${info(`${fake.length} domain(s) still resolve to fake-ip`)}`);

  if (api) {
    const suffixes = mergeHosts(internal.map((r) => r.name));
    if (suffixes.length) {
      let missing = [];
      for (const s of suffixes) {
        const res = await classifyDomain(s, internalDns);
        if (res.kind === "fake") missing.push(s);
      }
      if (missing.length) {
        exitCode = 1;
        console.log(`  ${bad(`${missing.length} suffix(es) still fake-ip — run: netfix fix`)}`);
        for (const m of missing) console.log(dim(`    +.${m}`));
      } else {
        console.log(`  ${ok("all internal suffixes resolve to private IPs")}`);
      }
    }
  }

  console.log();
  return exitCode;
}

export async function cmdFix(args) {
  const internalDns = args.flags["internal-dns"] || DEFAULT_INTERNAL_DNS;
  const assumeYes = args.flags.yes === true || args.flags.y === true;
  const frontend = await pickFrontend(args);
  const adapter = resolveAdapter(frontend);

  console.log(head(`\n── netfix fix (${frontend.label}) ──\n`));

  const { file: targetFile } = await adapter.prepare();
  const conn = await connect(frontend);
  const api = conn.api;
  console.log(`  ${ok(`mihomo API: ${api.descriptor}`)}`);
  console.log(`  ${info(`target: ${targetFile}`)}`);

  const repoRoots = args.flags.repos
    ? String(args.flags.repos).split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const scanned = await scanAll({ repoRoots, includeChrome: args.flags["no-chrome"] !== true });
  console.log(`  ${info(`scanned ${scanned.hosts.length} candidate hosts`)}`);

  const results = await probeDomains(scanned.hosts.map((h) => h.host), internalDns);
  const { internal, fake } = partitionByKind(results);

  if (!internal.length) {
    console.log(`  ${warn("no internal domains detected — nothing to fix")}`);
    return 0;
  }

  const suffixes = mergeHosts(internal.map((r) => r.name));
  const existing = adapter.readCurrentDns();
  const dnsSection = buildDnsSection({
    internalDns,
    internalSuffixes: suffixes,
    existing,
  });

  const before = Object.keys(existing).length ? dumpYaml({ dns: existing }, 0) : "";
  const after = dumpYaml({ dns: dnsSection }, 0);

  console.log(head("\n  Internal domains detected:"));
  for (const r of internal.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 30)) {
    console.log(`    ${r.name.padEnd(50)} ${dim(r.ips.join(", "))}`);
  }
  if (internal.length > 30) console.log(dim(`    … and ${internal.length - 30} more`));

  console.log(head(`\n  Suffixes to configure (${suffixes.length}):`));
  for (const s of suffixes) console.log(`    +.${s}`);

  const diff = renderDiff(before, after);
  console.log(head("\n  Config diff:"));
  if (diff.trim()) {
    for (const line of diff.split("\n")) {
      if (line.startsWith("+")) console.log(paint(C.green, `    ${line}`));
      else if (line.startsWith("-")) console.log(paint(C.red, `    ${line}`));
      else console.log(dim(`    ${line}`));
    }
  } else {
    console.log(dim("    (no changes)"));
  }

  if (!diff.trim()) {
    console.log(`\n  ${ok("configuration already up to date")}\n`);
    return 0;
  }

  if (!assumeYes) {
    const answer = await prompt("Apply these changes? [y/N] ");
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.log(`\n  ${warn("aborted — nothing was written")}\n`);
      return 1;
    }
  }

  const backup = backupDir();
  fs.mkdirSync(backup, { recursive: true });
  const backupFile = path.join(backup, path.basename(targetFile));
  fs.copyFileSync(targetFile, backupFile);
  console.log(`\n  ${info(`backup: ${backupFile}`)}`);

  await adapter.apply(dnsSection);
  console.log(`  ${ok("configuration written")}`);

  console.log(`  ${info(adapter.id === "clash-verge-rev" ? "restarting Clash Verge…" : "reloading core…")}`);
  await adapter.reload(api);
  await new Promise((r) => setTimeout(r, adapter.id === "clash-verge-rev" ? 9000 : 2000));

  const verify = await verifyFix(
    internal.map((r) => r.name),
    suffixes,
    internalDns,
    api,
  );
  if (verify.ok) {
    console.log(`  ${ok("verified — internal domains resolve to private IPs")}`);
    const checks = await Promise.all(
      internal.slice(0, 5).map((r) => httpCheck(r.name)),
    );
    for (const c of checks) {
      if (c.status) console.log(dim(`    ${c.host} → HTTP ${c.status}`));
      else console.log(dim(`    ${c.host} → ${c.error} (HTTP check is advisory only)`));
    }
    console.log();
    return 0;
  }

  console.log(`  ${bad(`verification failed: ${verify.reason}`)}`);
  console.log(`  ${info(`restoring backup from ${backupFile}`)}`);
  fs.copyFileSync(backupFile, targetFile);
  try {
    await adapter.reload(api);
  } catch {
    console.log(dim("    (reload failed — restart your proxy client manually)"));
  }
  console.log(`  ${warn("rolled back")}\n`);
  return 1;
}

async function verifyFix(hosts, suffixes, internalDns, api) {
  // Hard gate: every host we classified as internal must still resolve to a
  // private IP. A suffix that resolves publicly is fine — some of them are
  // only split-horizon for a subset of their hosts.
  for (const host of hosts) {
    const res = await classifyDomain(host, internalDns);
    if (res.kind !== "internal") {
      return {
        ok: false,
        reason: `${host} resolved to ${res.ips.join(",") || res.error} (expected a private IP)`,
      };
    }
  }

  // The collapsed suffix must at least resolve for real (never fake-ip),
  // otherwise the core is still handing out synthetic addresses.
  for (const suffix of suffixes) {
    const res = await classifyDomain(suffix, internalDns);
    if (res.kind === "fake") {
      return { ok: false, reason: `core still returns fake-ip for ${suffix}` };
    }
  }

  if (api) {
    try {
      const answers = await api.dnsAnswers(hosts[0] ?? suffixes[0] ?? "localhost");
      if (answers.some((ip) => ip.startsWith("198.18."))) {
        return { ok: false, reason: `core still returns fake-ip for ${hosts[0]}` };
      }
    } catch {
      // core may still be restarting; the DNS checks above are the primary signal
    }
  }

  return { ok: true };
}

function httpCheck(host) {
  return new Promise((resolve) => {
    const req = https.request(
      { host, port: 443, path: "/", method: "GET", timeout: 6000, rejectUnauthorized: false },
      (res) => {
        res.resume();
        resolve({ host, status: res.statusCode });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ host, error: "timeout" });
    });
    req.on("error", (err) => resolve({ host, error: err.code || err.message }));
    req.end();
  });
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close();
    resolve(answer);
  }));
}

export const HELP = `
${head("netfix")} — diagnose and fix proxy / internal-DNS misconfiguration

${head("Usage")}
  netfix doctor [options]     Diagnose environment, programs and internal domains
  netfix scan [options]       List candidate domains and how they resolve
  netfix fix [options]        Plan, preview, apply and verify a repair

${head("Options")}
  --internal-dns <ip>   Internal DNS server (default ${DEFAULT_INTERNAL_DNS})
  --repos <paths>       Comma-separated repo roots to scan
  --no-chrome           Skip Chrome history (it needs Full Disk Access)
  --frontend <id>       Force a frontend: clash-verge-rev | generic-mihomo
  --config <path>       Explicit config file (generic frontend)
  --yes, -y             Skip the confirmation prompt
  --help, -h            Show this help

${head("Examples")}
  netfix doctor
  netfix scan --repos ~/company
  netfix fix --yes
`;

export async function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0];

  if (args.flags.help || args.flags.h || !cmd) {
    console.log(HELP);
    return cmd ? 0 : 1;
  }

  try {
    switch (cmd) {
      case "doctor":
        return await cmdDoctor(args);
      case "scan":
        return await cmdScan(args);
      case "fix":
        return await cmdFix(args);
      default:
        console.error(`unknown command: ${cmd}`);
        console.log(HELP);
        return 1;
    }
  } catch (err) {
    console.error(bad(`\n${err.message}\n`));
    if (process.env.NETFIX_DEBUG) console.error(err.stack);
    return 1;
  }
}
