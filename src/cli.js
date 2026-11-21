import "./color-env.js";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { probeApi } from "./core/api.js";
import {
  discoverAll,
  systemProxyState,
  resolveInternalDns,
  parsePort,
  parseSecret,
} from "./core/discover.js";
import {
  discoverUpstream,
  verifyUpstream,
  describeCandidate,
  probeProxy,
  upstreamFromProbe,
  systemProxyPortsFromState,
  detectClient,
  detectActiveClient,
  detectControllerPorts,
  loadPinnedUpstream,
  savePinnedUpstream,
  clearPinnedUpstream,
  parseUpstream,
  detectPinnedDrift,
} from "./core/upstream.js";
import { detectEgress, describeEgress } from "./core/egress.js";
import { classifyDomain, probeServer, resolve4System } from "./core/dns.js";
import { dataDir, writeRuntime, clearRuntime, packageVersion } from "./core/paths.js";
import { createReporter } from "./cli/report.js";
import { scanAll } from "./core/scan.js";
import { inspectProcesses, proxyAdvice } from "./core/proc.js";
import {
  partitionByKind,
  mergeHostsValidated,
  buildDnsSection,
  renderDiff,
} from "./core/plan.js";
import { dumpYaml } from "./core/yaml.js";
import { HttpProxyServer, Socks5Server, normalizeInternalFallback } from "./core/relay.js";
import { checkTargets } from "./core/reach.js";
import {
  resolveTargets,
  parseTarget,
  addCustomTarget,
  removeCustomTarget,
  loadCustomTargets,
} from "./core/targets.js";
import {
  loadRules,
  ruleSuffixes,
  loadLearnedSuffixes,
  learnSuffixes,
} from "./core/rules.js";
import {
  installService,
  uninstallService,
  startService,
  stopService,
  restartService,
  serviceStatus,
  readServiceLog,
  setSessionProxyEnv,
  sessionProxyEnv,
  clearSessionProxyEnv,
} from "./core/launchd.js";
import {
  findApp,
  appVersion,
  readAppSettings,
  readCursorSettings,
  cursorProxyState,
  planCursorSettings,
  applyCursorSettingsText,
  stripJsonc,
  backupFile,
  listBackups,
  quitApp,
  openApp,
  readCodexEnv,
  applyEnvText,
  codexProxyState,
  networkPid,
  processProxyEnv,
  mainPid,
  waitForMainPid,
  APPS,
} from "./core/apps.js";
import { VergeAdapter } from "./adapters/verge.js";
import { GenericAdapter } from "./adapters/generic.js";

const DEFAULT_INTERNAL_DNS = "10.249.150.130";
const exec = promisify(execFile);

// TUI 调用时静默输出，避免刷屏破坏界面。
let quiet = false;
// 静默模式下把输出攒起来，调用方想知道「为什么失败」时能拿到原文。
let captured = null;
export function setQuiet(value) {
  quiet = Boolean(value);
  captured = quiet ? [] : null;
}

/** 取走静默模式下累积的输出（并清空）。 */
export function takeCapturedOutput() {
  const text = captured ? captured.join("\n") : "";
  if (captured) captured.length = 0;
  return text;
}
function say(text) {
  // 无参调用是想打印一个空行，而不是把 undefined 打出去
  if (quiet) {
    captured?.push(String(text ?? ""));
    return;
  }
  console.log(text ?? "");
}

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

// 这些是纯开关，不接受后面的值。
// 否则 `launch --write-settings Antigravity` 会把 Antigravity 当成
// --write-settings 的值吃掉，应用名就丢了。
const BOOLEAN_FLAGS = new Set([
  "yes",
  "y",
  "h",
  "help",
  "no-chrome",
  "print-env",
  "no-scan",
  "no-restart",
  "no-session-env",
  "write-settings",
  "keyword",
  "cidr",
  "version",
]);

// 单横线短选项 → 长选项。之前只认 --yes，`fix -y` 里 -y 会掉进
// 位置参数，确认提示照样弹；更糟的是 `launch -y Antigravity`
// 会把应用名吃成 -y。
const SHORT_FLAGS = { y: "yes", h: "help", v: "version" };

export function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        args.flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const name = a.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith("--") && !BOOLEAN_FLAGS.has(name)) {
          args.flags[name] = next;
          i += 1;
        } else {
          args.flags[name] = true;
        }
      }
    } else if (a.startsWith("-") && a.length > 1) {
      for (const ch of a.slice(1)) {
        const name = SHORT_FLAGS[ch];
        if (!name) {
          // 不认识的短选项当成位置参数，别静默吃掉
          args._.push(a);
          break;
        }
        args.flags[name] = true;
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

/**
 * --config <路径>：手递一份 mihomo 配置，绕开自动发现。
 * help 和适配器报错文案里都写了这个参数，但之前没人真的读它。
 */
function frontendFromConfig(configPath) {
  const file = path.resolve(String(configPath));
  if (!fs.existsSync(file)) {
    throw new Error(`--config 指定的文件不存在：${file}`);
  }
  const text = fs.readFileSync(file, "utf8");
  const controller =
    parsePort(text, "external-controller") ?? parsePort(text, "external-controller-tls");
  return {
    id: "generic-mihomo",
    label: `手动指定（${path.basename(file)}）`,
    home: path.dirname(file),
    apiCandidates: [
      ...(controller
        ? [{ host: "127.0.0.1", port: controller, secret: parseSecret(text) }]
        : []),
      { host: "127.0.0.1", port: 9090, secret: "" },
    ],
    configFile: file,
    configFiles: [file],
    mixedPort: parsePort(text, "mixed-port"),
    logDir: null,
  };
}

async function pickFrontend(args) {
  // 调用点传的是整个 args（{_, flags}），不是 flags 本身 ——
  // 之前直接读 .frontend/.config，这两个参数从来就没有真的生效过。
  const flags = args?.flags ?? args ?? {};
  if (flags.config) return frontendFromConfig(flags.config);
  const frontends = discoverAll();
  const explicit = flags.frontend;
  if (explicit) {
    const found = frontends.find((f) => f.id === explicit || f.label === explicit);
    if (!found) throw new Error(`未知客户端：${explicit}`);
    return found;
  }
  // 「装在机器上」不等于「正在用」。用户经常同时留着好几个客户端，
  // 只看目录会一直报旧的那个。以系统代理当前指向的端口为准 ——
  // 那个端口属于谁，就是用户正在用的客户端。
  const owner = await detectActiveClient();
  if (owner) {
    const match = frontends.find((f) => f.id === owner.id);
    if (match) return match;
  }
  for (const f of frontends) {
    if (f.id === "clash-verge-rev" && fs.existsSync(f.home)) return f;
  }
  return frontends[frontends.length - 1];
}

async function connect(frontend) {
  return probeApi(frontend.apiCandidates);
}

/**
 * 决定用哪个上游代理。
 *
 * 顺序是有讲究的：用户明确写的 > 之前钉住的 > 内核 API 报的 > 自动探测。
 * 自动探测放最后，因为它只能「猜」；但它是唯一不依赖具体客户端的一条路，
 * 所以对 Surge / Stash / ClashX / mihomo-party 这些用户来说就是唯一的路。
 */
export async function resolveUpstream(args = {}) {
  const explicit = parseUpstream(args.flags?.upstream);
  if (explicit) {
    const probed = await probeProxy(explicit.host, explicit.port);
    return upstreamFromProbe({
      host: explicit.host,
      port: explicit.port,
      probed,
      source: "flag",
      detail: `命令行指定 ${explicit.host}:${explicit.port}`,
    });
  }

  const pinned = loadPinnedUpstream();
  if (pinned) {
    const probed = await probeProxy(pinned.host, pinned.port);
    if (!probed.protocols.length && probed.authRequired.length) {
      return upstreamFromProbe({
        host: pinned.host,
        port: pinned.port,
        probed,
        source: "pinned",
        detail: `手动指定 ${pinned.host}:${pinned.port}`,
      });
    }
    const protocols = probed.protocols;
    if (protocols.length) {
      // 端口还活着，但可能已经属于旧客户端了。用户换了客户端、系统代理
      // 指向了新的端口，这时继续用钉住的值 = 流量被悄悄送回旧客户端。
      const drift = await detectPinnedDrift({ pinned });
      if (drift.stale) {
        return {
          upstream: {
            host: drift.replacement.host,
            port: drift.replacement.port,
            protocols: drift.replacement.protocols,
          },
          source: "pinned-stale",
          detail: `${drift.reason}，已改用 ${drift.replacement.host}:${drift.replacement.port}`,
          pinnedStale: { host: pinned.host, port: pinned.port, replacement: drift.replacement },
        };
      }
      return {
        upstream: { ...pinned, protocols },
        source: "pinned",
        detail: `手动指定 ${pinned.host}:${pinned.port}`,
      };
    }
    // 钉住的端口没了（换了客户端、改了端口）。照旧报错只会让用户
    // 每次开机都得手动改一次；回落到自动探测，但要说明「你选的那个不在了」。
    const fallback = await resolveUpstreamAuto(args);
    return {
      ...fallback,
      source: "pinned-dead",
      detail: fallback.upstream
        ? `${pinned.host}:${pinned.port} 不在了，临时改用 ${fallback.detail}`
        : `手动指定的 ${pinned.host}:${pinned.port} 现在没有代理在监听，且自动探测也没找到`,
      pinnedMissing: { host: pinned.host, port: pinned.port },
    };
  }

  return resolveUpstreamAuto(args);
}

/** 自动探测那一段，单独抽出来给「固定值失效」时复用 */
async function resolveUpstreamAuto(args = {}) {
  let mixedPort = null;
  try {
    const frontend = await pickFrontend(args);
    const conn = await connect(frontend);
    const cfg = await conn.api.configs();
    mixedPort = cfg["mixed-port"] ? Number(cfg["mixed-port"]) : null;
    if (mixedPort) {
      const probed = await probeProxy("127.0.0.1", mixedPort);
      if (probed.protocols.length) {
        return upstreamFromProbe({
          host: "127.0.0.1",
          port: mixedPort,
          probed,
          source: "core-api",
          detail: `${frontend.label} 的混合端口 ${mixedPort}`,
        });
      }
    }
  } catch {
    // 没有内核 API 很正常，继续走通用探测
  }

  const found = await discoverUpstream({ mixedPort });
  if (found.upstream) {
    return {
      upstream: found.upstream,
      source: found.chosen.source,
      detail: describeCandidate(found.chosen),
      candidates: found.candidates,
    };
  }
  return {
    upstream: null,
    source: "none",
    detail: "没有找到可用的代理。请先打开你的代理客户端，或运行 tunless upstream set 127.0.0.1:<端口>",
    candidates: found.candidates,
  };
}

function backendDir() {
  return dataDir();
}

function backupDir() {
  return path.join(backendDir(), "backups", new Date().toISOString().replace(/[:.]/g, "-"));
}

function validatedMerger(internalDns, extraSuffixes = []) {
  return (hosts) =>
    mergeHostsValidated(hosts, {
      classify: (name) => classifyDomain(name, internalDns),
      extraSuffixes,
    });
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
  const internalDns = await resolveInternalDns(args.flags["internal-dns"], DEFAULT_INTERNAL_DNS);
  const repoRoots = args.flags.repos
    ? String(args.flags.repos).split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const includeChrome = args.flags["no-chrome"] !== true;

  const frontend = await pickFrontend(args);
  const scanned = await scanAll({ repoRoots, includeChrome, logDir: frontend?.logDir ?? null });
  const hosts = scanned.hosts.map((h) => h.host);

  say(head(`\n共扫描到 ${hosts.length} 个候选域名`));
  say(dim(`  来源：${scanned.sources.join("、") || "无"}`));
  say(dim(`  内网 DNS：${internalDns}`));
  for (const note of scanned.notes) say(`  ${warn(note)}`);

  // 内网 DNS 不通就先确认，而不是逐个域名各等 3 秒超时
  const dnsAlive = await probeServer(internalDns);
  if (!dnsAlive.ok) {
    say(`\n  ${warn(`内网 DNS ${internalDns} 不可达（${dnsAlive.error}）`)}`);
    say(dim("    不在公司网络 / VPN 断连时会这样。连上后重跑，或用 --internal-dns 指定"));
    say(dim("    以下只列出扫描到的域名，不做内网/公网分类\n"));
    for (const h of hosts.slice(0, 40)) say(`  ${dim(h)}`);
    say();
    return 0;
  }

  const results = await probeDomains(hosts, internalDns);
  const { internal, fake, publicHosts, unresolved } = partitionByKind(results);

  say(head(`\n${head("内网域名")}（解析到私网地址 — ${internal.length}）`));
  for (const r of internal.sort((a, b) => a.name.localeCompare(b.name))) {
    say(`  ${ok(r.name.padEnd(50))} ${dim(r.ips.join(", "))}`);
  }
  say(head(`\n${head("假 IP 域名")}（需要加入过滤 — ${fake.length}）`));
  for (const r of fake.slice(0, 20)) {
    say(`  ${warn(r.name.padEnd(50))} ${dim(r.ips.join(", "))}`);
  }
  say(head(`\n${head("公网域名")}（${publicHosts.length}）— 仅显示前几个`));
  say(dim(`  ${publicHosts.slice(0, 10).map((r) => r.name).join(", ")}`));
  if (unresolved.length) {
    say(head(`\n${head("无法解析")}（${unresolved.length}）`));
    for (const r of unresolved.slice(0, 10)) say(`  ${dim(r.name)} — ${r.error}`);
  }
  say();
  return 0;
}

export async function cmdDoctor(args) {
  const internalDns = await resolveInternalDns(args.flags["internal-dns"], DEFAULT_INTERNAL_DNS);
  let exitCode = 0;
  // 渲染走 report.js：判词形状与 TUI 仪表盘同宗，
  // out 注入 say 保住 quiet/captured 机制。
  const rep = createReporter({ out: say });

  rep.section("环境");
  const frontend = await pickFrontend(args);
  // 只在「没认出 mihomo 系配置」时才用进程名兜底，
  // 否则会把 Verge 的 merge 文件能力说成别的客户端。
  const detected = frontend.id === "clash-verge-rev" ? null : await detectClient();
  const clientLabel = detected?.label ?? frontend.label;
  rep.line(info(`客户端：${clientLabel}`));
  // 认出来了但改不了它的配置，比假装支持要诚实。
  const canEditConfig = frontend.id === "clash-verge-rev" || Boolean(frontend.configFile);
  if (!canEditConfig) {
    rep.dim(
      frontend.runtimeOnly
        ? "配置由 GUI 在运行时注入，没有可写的磁盘配置：能转发代理，但改不了它的 DNS 分流"
        : "不是 mihomo 系：能转发代理，但改不了它的 DNS 分流",
    );
  }

  let api = null;
  if (frontend.runtimeOnly) {
    // wmsxwd 这类客户端：接口在跑，但需要 secret（存在加密存储里，读不出来）。
    const controllers = await detectControllerPorts();
    for (const c of controllers) {
      rep.line(info(`内核 REST 控制器：127.0.0.1:${c.port}`));
      if (c.needsSecret) {
        rep.dim("需要 secret，tunless 读不到（存在客户端的加密存储里）");
        rep.suggest("只影响「改 DNS 分流」，不影响转发代理");
      }
    }
    if (!controllers.length) {
      rep.dim("没找到内核的 REST 控制器（不影响转发）");
    }
  } else {
    try {
      const conn = await connect(frontend);
      api = conn.api;
      rep.row("ok", "内核接口", `可达（${conn.api.descriptor}）`);
      rep.dim(`版本：${conn.info.version}`);
    } catch (err) {
      exitCode = 1;
      rep.row("bad", "内核接口", "不可达");
      for (const f of err.failures ?? []) {
        rep.dim(`${f.candidate.socketPath ? `unix://${f.candidate.socketPath}` : `http://${f.candidate.host}:${f.candidate.port}`}: ${f.error}`);
      }
      rep.dim("这不影响转发：上游代理是按协议实测出来的，不依赖这个接口");
      rep.suggest("若确实没认出你的代理，运行 tunless upstream set 127.0.0.1:<端口>");
    }
  }

  if (api) {
    try {
      const cfg = await api.configs();
      const tun = cfg.tun?.enable;
      rep.row(tun ? "ok" : "warn", "TUN mode", tun ? "enabled" : "disabled");
      if (!tun) {
        rep.dim("programs that read HTTPS_PROXY/ALL_PROXY are covered by: tunless proxy");
        rep.dim("programs that ignore the proxy entirely need TUN mode");
      }
      const mode = cfg.mode;
      rep.line(info(`分流模式：${mode}`));
    } catch (err) {
      exitCode = 1;
      rep.row("bad", "内核配置", `读取失败：${err.message}`);
    }
  }

  const sysProxy = await systemProxyState();
  if (sysProxy) {
    const enabled = sysProxy.httpEnabled && sysProxy.httpsEnabled;
    rep.row(
      enabled ? "ok" : "warn",
      "系统代理",
      `${enabled ? "已启用" : "未启用"} ${sysProxy.host}:${sysProxy.port}`,
    );
  }

  if (frontend.id === "clash-verge-rev") {
    rep.row(frontend.mergeFile ? "ok" : "warn", "merge 文件", frontend.mergeFile ? "已找到" : "没有");
    if (frontend.mergeFile) rep.dim(frontend.mergeFile);
    rep.row(frontend.tunEnabled ? "ok" : "warn", "客户端 TUN", frontend.tunEnabled ? "已开启" : "已关闭");
  }

  // 上游探测与客户端无关：Surge / Stash / ClashX / sing-box 都走这里。
  rep.section("上游代理");
  const resolved = await resolveUpstream(args);
  if (resolved.upstream) {
    const { host, port } = resolved.upstream;
    // detail 里常常自带地址（「手动指定 127.0.0.1:6478」），剥掉再拼，别显示两遍。
    const why = String(resolved.detail ?? "")
      .replace(`${host}:${port}`, "")
      .trim()
      .replace(/^[（(]+|[）)]+$/g, "")
      .trim();
    rep.row("ok", "上游", `${host}:${port}${why ? `（${why}）` : ""}`);
    const check = await verifyUpstream(resolved.upstream);
    rep.row(check.ok ? "ok" : "warn", "连通性", `${check.ok ? "能出网" : "此刻出不了网"}${check.detail ? ` · ${check.detail}` : ""}`);
    // 「能出网」不代表模型目录全——出口落在受限区时 Cursor 等会缺
    // Gemini/Claude/GPT。单列一行，别混进连通性里。
    if (check.ok) {
      const eg = await detectEgress(resolved.upstream);
      const note = describeEgress(eg);
      if (note) rep.row(note.restricted ? "warn" : "ok", "出口样本", note.text);
    }
  } else {
    exitCode = 1;
    rep.row("bad", "上游", "没有找到可用的上游代理");
    rep.dim(resolved.detail);
    for (const c of (resolved.candidates ?? []).slice(0, 8)) {
      rep.dim(`候选 ${describeCandidate(c)}`);
    }
  }

  // 两件重活并发跑：进程二进制探测 + 域名扫描分类。
  // 之前串行，doctor 整体要 9 秒。
  const [procs, domainScan] = await Promise.all([
    inspectProcesses(),
    (async () => {
      const alive = await probeServer(internalDns);
      if (!alive.ok) {
        return { alive: false, error: alive.error, internal: [], suffixes: [] };
      }
      const repoRoots = args.flags.repos
        ? String(args.flags.repos).split(",").map((s) => s.trim()).filter(Boolean)
        : [];
      const scanned = await scanAll({
        repoRoots,
        includeChrome: args.flags["no-chrome"] !== true,
        logDir: frontend?.logDir ?? null,
      });
      const results = await probeDomains(scanned.hosts.map((h) => h.host), internalDns);
      const { internal } = partitionByKind(results);
      const suffixes = await validatedMerger(internalDns)(internal.map((r) => r.name));
      return { alive: true, internal, suffixes };
    })(),
  ]);

  rep.section("程序代理能力");
  if (!procs.length) {
    rep.dim("未发现相关进程");
  }
  // 只展示有结论的 + 前几个未知的 —— Electron 应用本来就查不出符号，
  // 全列出来是几十行噪音。
  const judged = procs.filter((p) => p.status !== "unknown");
  const unknown = procs.filter((p) => p.status === "unknown");
  const shown = [...judged, ...unknown.slice(0, 6)];
  for (const p of shown) {
    const badge =
      p.status === "supported"
        ? ok("支持代理环境变量")
        : p.status === "unsupported"
          ? warn("不支持代理环境变量")
          : dim("代理能力未知");
    rep.line(`${String(p.pid).padEnd(7)} ${p.comm.slice(0, 52).padEnd(52)} ${badge}`);
    if (p.status === "unsupported") rep.dim(`  ${proxyAdvice(p)}`);
  }
  if (procs.length > shown.length) {
    rep.dim(`…… 还有 ${procs.length - shown.length} 个进程无法判定（Electron 应用读不到符号，属正常）`);
  }

  // 「配置写了」不等于「现在真的在用」。这里只看能确凿观察到的连接，
  // 读不到就说读不到 —— 不拿环境变量推测定罪。
  rep.section("进程实际代理");
  for (const app of APPS) {
    if (app.id === "codex") continue;
    // 「在不在跑」看主进程；「联不联网」看子进程 —— 分开判，
    // 之前混在 networkPid 一个结果上，Cursor 被误报成「没在运行」。
    const running = await mainPid(app);
    if (!running) {
      rep.line(`${app.name.padEnd(14)} ${dim("没在运行")}`);
      continue;
    }
    const pid = await networkPid(app);
    const env = await processProxyEnv(pid);
    if (env?.hasProxy) {
      rep.line(`${app.name.padEnd(14)} ${ok(env.httpsProxy)} ${dim(`(pid ${pid})`)}`);
    } else if (env === null) {
      rep.line(`${app.name.padEnd(14)} ${dim("读不到该进程的连接信息")}`);
    } else {
      rep.line(`${app.name.padEnd(14)} ${warn("此刻没有代理连接")} ${dim(`(pid ${pid})`)}`);
      rep.suggest(`可能还没发请求；如果它一直连不上外网，试 tunless launch ${app.name}`);
    }
  }

  rep.section("转发服务");
  rep.line(info("tunless proxy 让工具无需 TUN 也能走代理"));
  rep.dim("tunless proxy            # HTTP 8899 / SOCKS5 8898");
  rep.dim("export HTTPS_PROXY=http://127.0.0.1:8899");

  rep.section("内网域名");
  if (!domainScan.alive) {
    rep.line(warn(`内网 DNS ${internalDns} 不可达（${domainScan.error}）`));
    rep.dim("跳过内网域名分类 —— 不在公司网络时这是正常现象");
  } else {
    const { internal, suffixes } = domainScan;
    rep.line(info(`${internal.length} 个内网域名解析到私网地址`));

    // 「还发不发假地址」要走系统解析器问 —— TUN 开着时内网 DNS 根本
    // 看不到 198.18.x，之前的查法永远是 0，等于没查。
    if (suffixes.length) {
      const checks = await Promise.all(
        suffixes.map(async (s) => ({ s, res: await resolve4System(s) })),
      );
      const missing = checks
        .filter((c) => c.res.ips?.some((ip) => ip.startsWith("198.18.")))
        .map((c) => c.s);
      if (missing.length) {
        exitCode = 1;
        rep.line(bad(`${missing.length} 个后缀仍是假 IP — 请运行：tunless fix`));
        for (const m of missing) rep.dim(`+.${m}`);
      } else {
        rep.line(ok("内网后缀经系统解析均不是假 IP"));
      }
    }
  }

  rep.blank();
  return exitCode;
}


export async function collectInternalSuffixes(frontend, internalDns, { scan = true, repoRoots = [] } = {}) {
  const suffixes = new Set();

  // 0. 历次扫描学到的 —— 集合只增不减。以前每次启动现场推导，
  //    昨天直连的域名今天就可能默默走了代理。
  for (const s of loadLearnedSuffixes()) suffixes.add(s);

  // 1. whatever the running client already routes to the internal resolver
  try {
    const adapter = resolveAdapter(frontend);
    const dns = adapter.readCurrentDns?.() ?? {};
    for (const key of Object.keys(dns["nameserver-policy"] ?? {})) {
      const clean = String(key).replace(/^\+\./, "").replace(/^["']|["']$/g, "");
      if (clean) suffixes.add(clean);
    }
    // 注意：fake-ip-filter 不当内网后缀。那里面是「内核不要发假地址」
    // 的名单，客户端默认配置里的 *.stun.* / ntp.org.cn 之类会被误当
    // 内网域名 → 走内网 DNS → NXDOMAIN → 502。
  } catch {
    // no readable client config — fall back to the scan only
  }

  // 2. hosts we can observe resolving to private addresses right now
  //    内网 DNS 不通就跳过 —— 否则每个候选域名都要等满一次超时。
  if (scan && (await probeServer(internalDns)).ok) {
    const scanned = await scanAll({ repoRoots, includeChrome: false, logDir: frontend?.logDir ?? null });
    const results = await probeDomains(scanned.hosts.map((h) => h.host), internalDns);
    const { internal } = partitionByKind(results);
    for (const suffix of await validatedMerger(internalDns)(internal.map((r) => r.name))) {
      suffixes.add(suffix);
    }
  }

  // 新发现落盘，下次启动直接用 —— 也是「只增不减」的另一半。
  learnSuffixes([...suffixes]);
  return [...suffixes].sort();
}

export async function cmdProxy(args) {
  const internalDns = await resolveInternalDns(args.flags["internal-dns"], DEFAULT_INTERNAL_DNS);
  const frontend = await pickFrontend(args);
  const httpPort = Number(args.flags.port || 8899);
  const socksPort = Number(args.flags["socks-port"] ?? 8898);

  const resolved = await resolveUpstream(args);
  if (!resolved.upstream) {
    say(head("\n── tunless proxy ──\n"));
    say(`  ${bad("没有可用的上游代理")}`);
    say(dim(`    ${resolved.detail}`));
    for (const c of (resolved.candidates ?? []).slice(0, 8)) {
      say(dim(`    候选 ${describeCandidate(c)}`));
    }
    say();
    return 1;
  }
  let upstream = {
    host: resolved.upstream.host,
    port: resolved.upstream.port,
    protocols: resolved.upstream.protocols ?? [],
  };
  const internalFallback = normalizeInternalFallback(args.flags["internal-fallback"]);

  const repoRoots = args.flags.repos
    ? String(args.flags.repos).split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const rules = loadRules();
  const suffixes = [
    ...new Set([
      ...(await collectInternalSuffixes(frontend, internalDns, {
        scan: args.flags["no-scan"] !== true,
        repoRoots,
      })),
      ...ruleSuffixes(rules),
    ]),
  ].sort();

  say(head("\n── tunless proxy ──\n"));
  say(`  ${info(`上游代理：${upstream.host}:${upstream.port}`)} ${dim(`（${resolved.detail}）`)}`);
  say(`  ${info(`内网域名：${suffixes.length ? suffixes.join("、") : "未检测到"}`)}`);
  say(`  ${info(`内网 DNS：${internalDns}`)}`);
  say(`  ${ok(`HTTP 代理 ：http://127.0.0.1:${httpPort}`)}`);
  if (socksPort) say(`  ${ok(`SOCKS5 代理：socks5://127.0.0.1:${socksPort}`)}`);

  const noProxy = suffixes.join(",");
  say(head("\n  让工具指向它："));
  say(dim("    export HTTPS_PROXY=http://127.0.0.1:" + httpPort));
  say(dim("    export HTTP_PROXY=http://127.0.0.1:" + httpPort));
  if (socksPort) say(dim("    export ALL_PROXY=socks5://127.0.0.1:" + socksPort));
  if (noProxy) say(dim(`    export NO_PROXY=${noProxy}`));
  say(dim("    （小写变量名同样有效）"));

  // --print-env 就该是纯打印：之前它还是会写登录会话变量，
  // 一条「只是看看」的命令产生了副作用。
  if (args.flags["print-env"] === true) {
    say();
    return 0;
  }

  // 只打印 export 语句是不够的：用户从 Dock 点开应用时根本没有这个环境。
  // 把变量写进 launchd 登录会话，所有新启动的 GUI 应用都会带上。
  // 认 --session-env=false / --session-env=0 / --no-session-env 三种写法；
  // 之前只认布尔 false，传字符串 "false" 会失效（真值判断）。
  const sessionEnvDisabled =
    args.flags["session-env"] === false ||
    args.flags["session-env"] === "false" ||
    args.flags["session-env"] === "0" ||
    args.flags["no-session-env"] === true;
  if (!sessionEnvDisabled) {
    const sessionEnv = {
      HTTPS_PROXY: `http://127.0.0.1:${httpPort}`,
      HTTP_PROXY: `http://127.0.0.1:${httpPort}`,
      https_proxy: `http://127.0.0.1:${httpPort}`,
      http_proxy: `http://127.0.0.1:${httpPort}`,
    };
    if (socksPort) {
      sessionEnv.ALL_PROXY = `socks5://127.0.0.1:${socksPort}`;
      sessionEnv.all_proxy = sessionEnv.ALL_PROXY;
    }
    if (noProxy) {
      sessionEnv.NO_PROXY = ["127.0.0.1", "localhost", "::1", ".local", ...suffixes].join(",");
      sessionEnv.no_proxy = sessionEnv.NO_PROXY;
    }
    try {
      await setSessionProxyEnv(sessionEnv);
      say(dim(`    已写入登录会话（从 Dock 打开的应用也会带上）`));
    } catch (err) {
      say(`  ${warn(`写入登录会话失败：${err.message}`)}`);
    }
  }

  // 日志去重：同一个 host:port -> 路由 的判定一分钟内只记一条。
  // 之前每条 CONNECT 都写，launchd 几天就把 proxy.log 灌到几万行，
  // 而且 `service logs` 只能看末尾 40 行 —— 全是噪音，没有历史。
  const seenRoutes = new Map();
  const log = (line) => {
    const now = Date.now();
    const last = seenRoutes.get(line) ?? 0;
    if (now - last < 60_000) return;
    seenRoutes.set(line, now);
    if (seenRoutes.size > 4096) seenRoutes.clear();
    say(dim(`    ${line}`));
  };
  const httpServer = new HttpProxyServer({
    port: httpPort,
    upstream,
    internalDns,
    internalSuffixes: suffixes,
    internalFallback,
    rules,
    log,
  });
  await httpServer.start();

  let socksServer = null;
  if (socksPort) {
    socksServer = new Socks5Server({
      port: socksPort,
      upstream,
      internalDns,
      internalSuffixes: suffixes,
      internalFallback,
      rules,
      log,
    });
    await socksServer.start();
  }

  say(head("\n  正在监听 — 按 Ctrl+C 停止。\n"));

  // 把「正在生效的配置」落盘：TUI / doctor 展示的分流域名应该
  // 以运行中的服务实际加载的这份为准，不是刚算出来的那份。
  writeRuntime({
    httpPort,
    socksPort,
    upstream,
    suffixes,
    internalDns,
    internalFallback,
  });

  // 上游热更新。转发服务是常驻的，用户随时可能换客户端
  // （Clash Verge → wmsxwd），端口也会跟着变。抱着旧端口不放 =
  // 流量悄悄走回旧客户端，而且界面上完全看不出来。
  //
  // 但 --upstream 显式指定时不刷：用户已经点名要这个端口，
  // 「自动发现换了别的」不应当覆盖用户的选择。
  const refresh = args.flags.upstream
    ? null
    : setInterval(async () => {
        try {
          const again = await resolveUpstream({ flags: {} });
          if (!again.upstream) return;
          if (
            again.upstream.host === upstream.host &&
            again.upstream.port === upstream.port
          ) {
            return;
          }
          upstream = {
            host: again.upstream.host,
            port: again.upstream.port,
            protocols: again.upstream.protocols ?? [],
          };
          httpServer.upstream = upstream;
          if (socksServer) socksServer.upstream = upstream;
          log(`上游已切换到 ${upstream.host}:${upstream.port}（${again.detail}）`);
          writeRuntime({ httpPort, socksPort, upstream, suffixes, internalDns, internalFallback });
        } catch {
          // 探测失败就保持现状，别把正在用的连接弄断
        }
      }, 30_000);
  refresh?.unref?.();

  const shutdown = async () => {
    say(dim("\n  正在停止…"));
    if (refresh) clearInterval(refresh);
    clearRuntime();
    await httpServer.stop();
    if (socksServer) await socksServer.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise(() => {});
  return 0;
}



export async function cmdLaunch(args) {
  const app = args.flags.app || args._[1] || "Antigravity";
  const httpPort = Number(args.flags.port || 8899);
  const socksPort = Number(args.flags["socks-port"] ?? 8898);

  // Resolve the internal domains the same way the sidecar does, so the
  // NO_PROXY list stays consistent with the routing rules.
  const internalDns = await resolveInternalDns(args.flags["internal-dns"], DEFAULT_INTERNAL_DNS);
  const frontend = await pickFrontend(args);
  const repoRoots = args.flags.repos
    ? String(args.flags.repos).split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const suffixes = [
    ...new Set([
      ...(await collectInternalSuffixes(frontend, internalDns, {
        scan: args.flags["no-scan"] !== true,
        repoRoots,
      })),
      ...ruleSuffixes(loadRules()),
    ]),
  ].sort();
  const noProxyList = ["127.0.0.1", "localhost", "::1", ".local", ...suffixes]
    .filter(Boolean)
    .join(",");

  const env = {
    HTTPS_PROXY: `http://127.0.0.1:${httpPort}`,
    HTTP_PROXY: `http://127.0.0.1:${httpPort}`,
    https_proxy: `http://127.0.0.1:${httpPort}`,
    http_proxy: `http://127.0.0.1:${httpPort}`,
    NO_PROXY: noProxyList,
    no_proxy: noProxyList,
  };
  if (socksPort) {
    env.ALL_PROXY = `socks5://127.0.0.1:${socksPort}`;
    env.all_proxy = env.ALL_PROXY;
  }

  say(head("\n── tunless 启动应用 ──\n"));
  say(`  ${info(`应用：${app}`)}`);
  say(`  ${info(`代理：http://127.0.0.1:${httpPort}${socksPort ? ` / socks5://127.0.0.1:${socksPort}` : ""}`)}`);
  say(`  ${dim(`NO_PROXY：${noProxyList}`)}`);

  // VS Code 系应用（Antigravity / Cursor）的 Chromium 部分读 http.proxy，
  // 光给环境变量只通一半。但要不要改用户的配置文件由用户决定：
  // 默认只注入环境变量，加 --write-settings 才写 settings.json。
  const target = findApp(app);
  const wantSettings = args.flags["write-settings"] === true;

  // Codex 不是 GUI，没有「重启」这回事，直接把 .env 写好就结束。
  if (target?.id === "codex") {
    if (wantSettings) {
      const result = await configureCodex({
        proxyUrl: `http://127.0.0.1:${httpPort}`,
        noProxy: env.NO_PROXY,
        yes: true,
        quiet,
        app: target,
      });
      if (!result.ok) return 1;
    } else {
      say(dim(`  Codex 的 ~/.codex/.env 未改动（需要的话加 --write-settings）`));
      say(dim(`    注意：Codex 会优先读那个文件，只给环境变量可能被它盖掉`));
    }
    if (args.flags["print-env"] === true) {
      for (const [key, value] of Object.entries(env)) say(dim(`    export ${key}=${value}`));
      say();
    }
    say(`\n  ${ok("Codex 已配置。新开一个终端跑 codex 就生效")}\n`);
    return 0;
  }

  if (wantSettings && target?.settingsPath) {
    const result = await configureCursor({
      proxyUrl: `http://127.0.0.1:${httpPort}`,
      yes: true,
      quiet: false,
      app: target,
    });
    if (!result.ok) return 1;
  } else if (target?.settingsPath) {
    say(dim(`  ${target.name} 的配置文件未改动（需要的话加 --write-settings）`));
  }

  // --print-env 只打印变量，不启动应用
  if (args.flags["print-env"] === true) {
    for (const [key, value] of Object.entries(env)) say(dim(`    export ${key}=${value}`));
    say();
    return 0;
  }

  const beforePid = target ? await mainPid(target) : null;
  const quitResult = await quitApp({ bundle: app.replace(/\.app$/, "") });
  if (!quitResult.quit) {
    say(`  ${warn(`${app} 没能完全退出（pid ${quitResult.pid}），环境变量无法生效`)}`);
    say(dim("    请手动 Cmd+Q 退出后再运行这条命令"));
    return 1;
  }
  if (quitResult.escalated) {
    say(dim(`    注意：${app} 忽略了正常退出请求，已强制关闭以便带代理重启`));
  }
  await new Promise((r) => setTimeout(r, target?.settingsPath ? 2000 : 800));
  const opened = await openApp({ bundle: app.replace(/\.app$/, "") }, env);
  if (opened.launched === false) {
    say(`  ${bad(`${app.replace(/\.app$/, "")} 没能启动`)}`);
    return 1;
  }
  if (opened.envApplied === false) {
    say(`  ${warn("这个 macOS 版本不支持 open --env，应用已启动但没带上代理环境变量")}`);
    say(dim("    请在应用自己的设置里配置代理，或升级到 macOS 13 以上"));
  }
  say(`\n  ${ok(`已使用 tunless 代理启动 ${app.replace(/\.app$/, "")}`)}\n`);

  // 启动成功 ≠ 代理生效。等它真发出请求，再看这条连接去了哪儿。
  const target2 = findApp(app);
  if (target2 && target2.id !== "codex") {
    // 先确认它真的起来了。open -a 返回只代表「系统收到请求」。
    const observedPid = await waitForMainPid(target2);
    if (!observedPid) {
      say(`  ${bad(`${app.replace(/\.app$/, "")} 15 秒内没有启动起来`)}`);
      say(dim("    可以在 Finder 里双击试试；若也起不来，说明是应用本身的问题\n"));
      return 1;
    }
    if (beforePid && observedPid === beforePid) {
      // 同一个 pid 说明旧实例没退，环境变量还是旧的
      say(`  ${warn(`进程没有更换（pid ${observedPid}），环境变量可能还是旧的`)}`);
      say(dim("    请手动 Cmd+Q 完全退出后重试\n"));
      return 1;
    }
    for (let i = 0; i < 10; i++) {
      const netPid = await networkPid(target2);
      const netEnv = await processProxyEnv(netPid);
      if (netEnv?.hasProxy) {
        say(`  ${ok(`代理已生效：${netEnv.httpsProxy}`)} ${dim(`(pid ${netPid})`)}\n`);
        return 0;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    say(`  ${dim("应用已启动，但还没观察到它的代理连接")}`);
    say(dim("    应用发出第一个请求后就会走代理；可以用 tunless doctor 复查\n"));
  }
  return 0;
}

/**
 * Cursor 专用：把代理写进 settings.json。
 *
 * 只修这个不修那个是没用的 —— Cursor 的 Chromium 部分读 http.proxy，
 * Agent 的 Node 传输层读环境变量；3.28 之前 HTTP/2 通路还会完全绕过代理。
 */
export async function configureCursor({ proxyUrl, yes = false, quiet = false, app = null } = {}) {
  const target = app ?? findApp("cursor");
  const settings = readAppSettings(target);
  const version = appVersion(target.bundle);
  const current = cursorProxyState(settings);
  const { changes, warnings } = planCursorSettings({ proxyUrl, version, app: target });

  if (!settings.exists) {
    say(`  ${warn(`没找到 ${target.name} 配置：${settings.file}`)}`);
    say(dim(`    先打开一次 ${target.name}，让它生成配置再运行这条命令`));
    return { ok: false };
  }
  if (settings.parseError) {
    say(`  ${warn(`${target.name} 配置无法解析：${settings.parseError}`)}`);
    say(dim("    为避免写坏配置，这里不做修改"));
    return { ok: false };
  }

  const diff = [];
  for (const [key, value] of Object.entries(changes)) {
    const before = settings.data[key];
    if (before !== value) diff.push({ key, before, after: value });
  }

  if (!quiet) {
    say(head(`\n── ${target.name} 代理配置 ──\n`));
    say(`  ${info(`版本：${version ?? "未知"}`)}`);
    say(`  ${info(`配置文件：${settings.file}`)}`);
    if (current.proxySupport && current.proxySupport !== "override") {
      say(`  ${warn(`http.proxySupport 目前是 ${current.proxySupport}，会被改成 override`)}`);
    }
  }

  for (const warning of warnings) say(`  ${warn(warning)}`);

  if (!diff.length) {
    say(`  ${ok("代理设置已经就绪，无需改动")}`);
    return { ok: true, changed: false };
  }

  if (!quiet) {
    say(head(`\n  将要修改（${diff.length} 项）：`));
    for (const d of diff) {
      say(`    ${d.key}`);
      say(dim(`      现在：${d.before === undefined ? "（未设置）" : JSON.stringify(d.before)}`));
      say(`      改为：${JSON.stringify(d.after)}`);
    }
  }

  if (!yes) {
    const answer = await prompt(`\n  确认写入 ${target.name} 配置？[y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) {
      say(`\n  ${warn("已取消 — 未写入任何内容")}\n`);
      return { ok: false, changed: false };
    }
  }

  const backup = backupFile(settings.file);
  say(`\n  ${info(`已备份：${backup}`)}`);
  const next = applyCursorSettingsText(settings.raw, changes);
  try {
    JSON.parse(stripJsonc(next));
  } catch (err) {
    say(`  ${bad(`生成的配置不合法，已中止：${err.message}`)}`);
    return { ok: false };
  }
  fs.writeFileSync(settings.file, next, "utf8");
  say(`  ${ok(`${target.name} 配置已更新`)}`);
  return { ok: true, changed: true };
}

/**
 * 列出 / 还原配置备份。
 *
 * 每次写应用的配置前都会备份，但之前只能自己到
 * ~/.tunless/backups/ 里手动翻文件。这里给一条命令。
 */
/**
 * 查看 / 撤销写进 launchd 登录会话的代理变量。
 *
 * 这个命令存在的理由是：我们改了系统级的东西就一定要能看见、能撤销。
 * `launchctl setenv` 的效果会一直留到注销，撤销后必须重新启动应用才恢复。
 */
export async function cmdEnv(args) {
  const action = args._[1] || "show";
  const rep = createReporter({ out: say });

  if (action === "clear" || action === "unset") {
    const before = await sessionProxyEnv();
    await clearSessionProxyEnv();
    if (!Object.keys(before).length) {
      rep.dim("登录会话里本来就没有代理变量。\n");
      return 0;
    }
    rep.row("ok", "登录会话", "已移除代理变量");
    for (const key of Object.keys(before)) rep.dim(key);
    rep.dim("\n已经打开的应用还带着旧变量，重启它们才会回到直连。\n");
    return 0;
  }

  const current = await sessionProxyEnv();
  rep.section("登录会话代理变量");
  if (!Object.keys(current).length) {
    rep.dim("没有设置。从 Dock / Finder 打开的应用不会自动带代理。");
    rep.dim("运行 `tunless service install` 或 `tunless proxy` 会写入。\n");
    return 0;
  }
  for (const [key, value] of Object.entries(current)) {
    rep.line(`${key.padEnd(12)} ${dim(value)}`);
  }
  rep.suggest("撤销：tunless env clear\n");
  return 0;
}

export async function cmdRestore(args) {
  const action = args._[1] || "list";
  const backups = listBackups();

  if (action === "list" || action === undefined) {
    say(head("\n── 配置备份 ──\n"));
    if (!backups.length) {
      say(dim("  还没有备份。改过应用配置之后才会有。\n"));
      return 0;
    }
    backups.slice(0, 20).forEach((b, i) => {
      const when = b.mtime.toLocaleString("zh-CN", { hour12: false });
      if (b.legacy) {
        say(`  ${dim(`${i + 1}.`)} ${when}  ${dim(b.name)} ${warn("（旧格式，无法自动还原）")}`);
      } else {
        say(`  ${info(`${i + 1}.`)} ${when}  ${b.target}`);
      }
    });
    say(dim(`\n  共 ${backups.length} 份。还原：tunless restore <序号>\n`));
    return 0;
  }

  const index = Number(action) - 1;
  const target = Number.isInteger(index) ? backups[index] : null;
  if (!target) {
    say(`  ${bad(`没有第 ${action} 份备份`)}`);
    return 1;
  }
  if (target.legacy) {
    say(`  ${warn("这份备份是旧格式，不知道它来自哪个文件，没法自动还原")}`);
    say(dim(`    文件还在：${target.file}`));
    return 1;
  }

  say(`\n  即将把备份还原到：${info(target.target)}`);
  const answer =
    args.flags.yes === true
      ? "y"
      : await prompt(`${warn("这会覆盖当前内容")}，确认？[y/N] `);
  if (!/^y(es)?$/i.test(answer.trim())) {
    say(dim("\n  已取消\n"));
    return 1;
  }

  // 覆盖前先给当前内容也留一份，防止还原错了回不去
  if (fs.existsSync(target.target)) backupFile(target.target);
  fs.mkdirSync(path.dirname(target.target), { recursive: true });
  fs.copyFileSync(target.file, target.target);
  say(`  ${ok("已还原")}  ${target.target}\n`);
  return 0;
}

/**
 * Codex 专用：把代理写进 ~/.codex/.env。
 *
 * 为什么要改文件而不是只设环境变量 —— 实测结论：
 * Codex 启动时会读 <CODEX_HOME>/.env 并注入进程环境，其优先级高于
 * 外面传进来的 HTTPS_PROXY。所以只 export 环境变量会被 .env 里的旧值
 * 盖掉，表现为「明明设了代理，日志里却还连 127.0.0.1:7897」。
 */
export async function configureCodex({ proxyUrl, noProxy, yes = false, quiet = false, app = null } = {}) {
  const target = app ?? findApp("codex");
  const env = readCodexEnv(target);
  const noProxyValue = noProxy || "localhost,127.0.0.1,::1,.local";

  const changes = {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    NO_PROXY: noProxyValue,
  };

  const diff = [];
  for (const [key, value] of Object.entries(changes)) {
    if (env.data[key] !== value) diff.push({ key, before: env.data[key], after: value });
  }

  if (!quiet) {
    say(head(`\n── ${target.name} 代理配置 ──\n`));
    say(`  ${info(`配置文件：${env.file}`)}`);
    if (!env.exists) {
      say(`  ${warn("这个文件还不存在，会新建一个（Codex 会读它）")}`);
    }
  }

  if (!diff.length) {
    say(`  ${ok("代理设置已经就绪，无需改动")}`);
    return { ok: true, changed: false };
  }

  if (!quiet) {
    say(head(`\n  将要修改（${diff.length} 项）：`));
    for (const d of diff) {
      say(`    ${d.key}`);
      say(dim(`      现在：${d.before === undefined ? "（未设置）" : d.before}`));
      say(`      改为：${d.after}`);
    }
  }

  if (!yes) {
    const answer = await prompt(`\n  确认写入 ${target.name} 的 .env？[y/N] `);
    if (!/^y(es)?$/i.test(answer.trim())) {
      say(`\n  ${warn("已取消 — 未写入任何内容")}\n`);
      return { ok: false, changed: false };
    }
  }

  // 目录可能不存在（CODEX_HOME 指到新地方时）
  fs.mkdirSync(path.dirname(env.file), { recursive: true });
  const backup = env.exists ? backupFile(env.file) : null;
  if (backup) say(`\n  ${info(`已备份：${backup}`)}`);
  fs.writeFileSync(env.file, applyEnvText(env.raw, changes), "utf8");
  say(`  ${ok(`${target.name} 代理配置已更新`)}`);
  return { ok: true, changed: true };
}

export async function cmdCursor(args) {
  const httpPort = Number(args.flags.port || 8899);
  const result = await configureCursor({
    proxyUrl: `http://127.0.0.1:${httpPort}`,
    yes: args.flags.yes === true || args.flags.y === true,
  });
  if (!result.ok) return 1;

  if (args.flags["no-restart"] === true) return 0;

  const internalDns = await resolveInternalDns(args.flags["internal-dns"], DEFAULT_INTERNAL_DNS);
  const frontend = await pickFrontend(args);
  const suffixes = [
    ...new Set([
      ...(await collectInternalSuffixes(frontend, internalDns, { scan: false })),
      ...ruleSuffixes(loadRules()),
    ]),
  ].sort();
  const noProxyList = ["127.0.0.1", "localhost", "::1", ".local", ...suffixes].join(",");
  const env = {
    HTTPS_PROXY: `http://127.0.0.1:${httpPort}`,
    HTTP_PROXY: `http://127.0.0.1:${httpPort}`,
    https_proxy: `http://127.0.0.1:${httpPort}`,
    http_proxy: `http://127.0.0.1:${httpPort}`,
    NO_PROXY: noProxyList,
    no_proxy: noProxyList,
  };

  say(`\n  ${info("正在完全退出 Cursor，让设置生效…")}`);
  const quitResult = await quitApp(findApp("cursor"));
  if (!quitResult.quit) {
    say(`  ${warn(`Cursor 没能退出（pid ${quitResult.pid}），请手动 Cmd+Q 后再试`)}`);
    say(dim("    settings.json 已经写好，重新打开 Cursor 即可生效\n"));
    return 1;
  }
  if (quitResult.escalated) {
    say(dim("    注意：Cursor 忽略了正常退出，已强制关闭（VS Code 会恢复未保存的编辑）"));
  }
  await new Promise((r) => setTimeout(r, 2000));
  await openApp(findApp("cursor"), env);
  say(`  ${ok("Cursor 已带着代理重新启动")}`);
  say(dim("  验证方式：在 Cursor 里发一条消息，模型能回就说明通了\n"));
  return 0;
}

/**
 * 手动指定 / 查看上游代理。
 *
 * 这解决的问题是：自动探测只能认出「已知客户端 + 回环端口」。用户用了个
 * 我们没见过的客户端、或者代理绑在 127.0.0.2、或者端口是随机的，就必须能
 * 自己写一句。写下来的端口会存进 ~/.tunless/upstream.json，
 * launchd 拉起的常驻服务也能读到。
 */
export async function cmdUpstream(args) {
  const action = args._[1] || "status";

  if (action === "set") {
    const parsed = parseUpstream(args._[2] ?? args.flags.port);
    if (!parsed) {
      say(`  ${bad("用法：tunless upstream set 127.0.0.1:7897")}`);
      return 1;
    }
    const probed = await probeProxy(parsed.host, parsed.port);
    const protocols = probed.protocols;
    if (probed.authRequired.length && !protocols.length) {
      say(`  ${warn(`${parsed.host}:${parsed.port} 需要认证（${probed.authRequired.join("+")}）`)}`);
      say(dim("    当前不代填凭据，不会把它当成可用上游"));
    } else if (!protocols.length) {
      say(`  ${warn(`${parsed.host}:${parsed.port} 上没有认出免认证的 HTTP/SOCKS`)}`);
      say(dim("    仍然会保存。如果是 TUN 下才开放的端口，开着 TUN 再试一次"));
    }
    // 记下「此刻系统代理指向哪些端口」：同一客户端的 HTTP 和 SOCKS 不算换客户端。
    const sys = await systemProxyState();
    const systemProxyPorts = systemProxyPortsFromState(sys);
    const file = savePinnedUpstream({
      ...parsed,
      systemProxyPorts,
      systemProxyPort: systemProxyPorts[0] ?? null,
    });
    say(`\n  ${ok(`已指定上游代理 ${parsed.host}:${parsed.port}`)}`);
    if (protocols.length) say(dim(`    识别为 ${protocols.join(" + ")}`));
    say(dim(`    保存于 ${file}`));
    // 服务在跑就直接重启让新上游生效 —— 之前让用户自己 uninstall &&
    // install，两步操作里 uninstall 还会把登录会话变量清掉。
    const svc = await serviceStatus();
    if (svc.running) {
      say(dim("\n    正在重启转发服务让新上游生效…"));
      const st = await restartService();
      say(
        st.running
          ? `  ${ok("转发服务已重启，新上游已生效")}`
          : `  ${warn("转发服务没有起来，tunless service logs 看原因")}`,
      );
    } else {
      say(dim("\n    转发服务没在运行，下次启动就会用上新端口"));
    }
    say(dim("    恢复自动探测：tunless upstream clear\n"));
    return 0;
  }

  if (action === "clear") {
    const removed = clearPinnedUpstream();
    say(
      removed
        ? `\n  ${ok("已清除手动指定的上游，改回自动探测")}\n`
        : `\n  ${dim("本来就没有手动指定过上游")}\n`,
    );
    return 0;
  }

  const pinned = loadPinnedUpstream();
  const rep = createReporter({ out: say });
  rep.section("上游代理");
  if (pinned) {
    rep.row("ok", "手动指定", `${pinned.host}:${pinned.port}`);
  } else {
    rep.dim("未手动指定，当前为自动探测");
  }

  const resolved = await resolveUpstream({ flags: {} });
  if (resolved.upstream) {
    const { host, port } = resolved.upstream;
    const why = String(resolved.detail ?? "")
      .replace(`${host}:${port}`, "")
      .trim()
      .replace(/^[（(]+|[）)]+$/g, "")
      .trim();
    rep.row("ok", "实际使用", `${host}:${port}${why ? `（${why}）` : ""}`);
    if (resolved.pinnedStale) {
      rep.row("warn", "固定漂移", `你固定的 ${resolved.pinnedStale.host}:${resolved.pinnedStale.port} 已经不是你现在的客户端了`);
      rep.suggest("已自动改用系统代理指向的端口。要固定下来：tunless upstream set <新端口>");
    }
    if (resolved.pinnedMissing) {
      rep.row("warn", "固定失效", `你固定的 ${resolved.pinnedMissing.host}:${resolved.pinnedMissing.port} 现在没有代理`);
      rep.suggest("已临时回落到自动探测。要更新固定值：tunless upstream set <新端口>");
    }
  } else {
    rep.row("warn", "上游", "当前没有可用的上游代理");
    rep.dim(resolved.detail);
  }

  const found = await discoverUpstream({
    mixedPort: null,
    timeoutMs: 800,
  });
  if (found.candidates.length) {
    rep.blank();
    rep.line(head("本机候选："));
    for (const c of found.candidates.slice(0, 12)) {
      const mark = c.isProxy ? paint(C.green, "✔") : paint(C.dim, "·");
      rep.line(`${mark} ${describeCandidate(c)} ${c.process ? dim(`— ${c.process}`) : ""}`);
    }
  }
  rep.suggest("tunless upstream set 127.0.0.1:7897   # 手动指定");
  rep.suggest("tunless upstream clear                 # 恢复自动探测\n");
  return resolved.upstream ? 0 : 1;
}

async function probeProtocolsSafe(host, port) {
  try {
    const { probeProtocols } = await import("./core/upstream.js");
    return await probeProtocols(host, port);
  } catch {
    return [];
  }
}

/**
 * 测外网：默认测「这个工具自己会连的域名」，而不是固定的 github。
 *
 * Antigravity 报的是 `Post https://oauth2.googleapis.com/token: i/o timeout`，
 * 那就该测 oauth2.googleapis.com —— 测 github 通不通说明不了任何问题。
 */
export async function cmdTest(args) {
  const appId = String(args.flags.app ?? args._[1] ?? "").toLowerCase();
  const { findApp } = await import("./core/apps.js");
  const app = appId ? findApp(appId) : null;
  const port = Number(args.flags.port || 8899);

  const targets = resolveTargets(app?.id ?? appId, {
    includeCustom: args.flags["no-custom"] !== true,
  });
  if (!targets.length) {
    say(`  ${bad("没有要测的目标")}`);
    return 1;
  }

  say(head("\n── 测外网 ──\n"));
  say(
    `  ${info(
      app
        ? `按 ${app.name} 实际会连的域名测`
        : "没指定工具，测通用目标（加 --app antigravity|cursor|codex 更准）",
    )}`,
  );
  say(dim(`    代理：127.0.0.1:${port}`));
  say();

  const checked = await checkTargets({ port, targets });
  const results = checked.results;
  for (const r of results) {
    const tag = r.ok ? paint(C.green, "✔") : paint(C.red, "✖");
    const where = r.port === 443 ? r.host : `${r.host}:${r.port}`;
    // 可选目标不通时不能显示成红叉 —— 那会让用户以为工具坏了。
    // 用灰点标记，并在行尾写明「不影响结论」。
    const opt = r.optional && !r.ok;
    const mark = opt ? paint(C.dim, "·") : tag;
    const label = r.label
      ? dim(`  ${r.label}${opt ? "（可选，不影响结论）" : ""}`)
      : "";
    const timing = dim(`  ${r.ms}ms`);
    say(`  ${mark} ${where.padEnd(38)}${label}${timing}`);
    if (r.detail && (!r.ok || r.serviceVerified === false)) say(dim(`      ${r.detail}`));
  }

  say();
  if (checked.serviceVerified) {
    say(`  ${ok("带账号的服务调用已通过")}`);
  } else if (checked.ok) {
    say(`  ${warn("隧道到达对端，服务未验证")}`);
    say(dim("    HTTP 状态只说明请求到了对端。401/403/429 不能当成模型或账号可用"));
    if (checked.failedOptional.length) {
      say(dim(`    ${checked.failedOptional.length} 个可选目标没通，不影响隧道结论`));
    }
  } else {
    say(`  ${bad(`${checked.failedRequired.length} 个必需目标不通`)}`);
    say(dim("    先确认转发服务在跑：tunless service status"));
  }
  say();
  return checked.ok ? 0 : 1;
}

/** 管理「测外网」用的自定义目标 */
export async function cmdTargets(args) {
  const action = args._[1] || "list";

  if (action === "add") {
    const parsed = parseTarget(args._[2] ?? args.flags.host);
    if (!parsed) {
      say(`  ${bad("用法：tunless targets add api.example.com 或 api.example.com:8443/path")}`);
      return 1;
    }
    const { targets, added } = addCustomTarget(parsed);
    if (!added) {
      say(`  ${warn(`${parsed.host}:${parsed.port} 已经在列表里`)}`);
      return 0;
    }
    say(`\n  ${ok(`已添加测试目标 ${parsed.host}:${parsed.port}${parsed.path}`)}`);
    say(dim(`    共 ${targets.length} 个自定义目标`));
    say(dim("    下次 tunless test 会一起测\n"));
    return 0;
  }

  if (action === "remove" || action === "rm") {
    const raw = String(args._[2] ?? args.flags.host ?? "").trim();
    const parsed = parseTarget(raw);
    if (!parsed) {
      say(`  ${bad("用法：tunless targets remove api.example.com")}`);
      return 1;
    }
    // 不写端口就删这个主机名下所有端口，符合「把这条去掉」的直觉
    const explicitPort = /:\d+/.test(raw.replace(/^https?:\/\//, "").split("/")[0]);
    const { removed } = removeCustomTarget(
      parsed.host,
      explicitPort ? parsed.port : null,
    );
    say(
      removed
        ? `\n  ${ok(`已移除 ${parsed.host}${explicitPort ? `:${parsed.port}` : ""}`)}\n`
        : `\n  ${warn(`没有 ${parsed.host}${explicitPort ? `:${parsed.port}` : ""}`)}\n`,
    );
    return removed ? 0 : 1;
  }

  const custom = loadCustomTargets();
  const rep = createReporter({ out: say });
  rep.section("测试目标");
  for (const [appId, list] of Object.entries((await import("./core/targets.js")).APP_TARGETS)) {
    rep.line(info(appId));
    for (const t of list) {
      rep.dim(`${t.host}${t.port === 443 ? "" : `:${t.port}`}${t.path === "/" ? "" : t.path}  ${t.label ?? ""}`);
    }
  }
  rep.line(info("自定义"));
  if (!custom.length) {
    rep.dim("（还没有）");
  } else {
    for (const t of custom) {
      rep.dim(`${t.host}${t.port === 443 ? "" : `:${t.port}`}${t.path === "/" ? "" : t.path}`);
    }
  }
  rep.suggest("tunless targets add api.example.com");
  rep.suggest("tunless targets remove api.example.com\n");
  return 0;
}

export async function cmdService(args) {
  /** 生成要写进登录会话的那组代理变量 */
  async function buildSessionEnv(serviceArgs) {
    const httpPort = Number(serviceArgs.flags?.port || 8899);
    const socksPort = Number(serviceArgs.flags?.["socks-port"] ?? 8898);
    const env = {
      HTTPS_PROXY: `http://127.0.0.1:${httpPort}`,
      HTTP_PROXY: `http://127.0.0.1:${httpPort}`,
      https_proxy: `http://127.0.0.1:${httpPort}`,
      http_proxy: `http://127.0.0.1:${httpPort}`,
    };
    if (socksPort) {
      env.ALL_PROXY = `socks5://127.0.0.1:${socksPort}`;
      env.all_proxy = env.ALL_PROXY;
    }
    const noProxy = [
      "127.0.0.1",
      "localhost",
      "::1",
      ".local",
      ...ruleSuffixes(loadRules()),
      ...loadLearnedSuffixes(),
    ].join(",");
    env.NO_PROXY = noProxy;
    env.no_proxy = noProxy;
    return env;
  }

  const action = args._[1] || args.flags.action || "status";
  const forward = ["proxy", ...process.argv.slice(4)];

  if (action === "install") {
    // 常驻服务要同时把代理写进登录会话，否则用户从 Dock 点开应用时
    // 环境里依然什么都没有（那正是 Antigravity 报 i/o timeout 的场景）。
    const installArgs = forward.includes("--session-env")
      ? forward
      : [...forward, "--session-env"];
    const { plist } = await installService({ args: installArgs });
    const writeSessionEnv = !forward.includes("--no-session-env");
    if (writeSessionEnv) {
      try {
        const env = await buildSessionEnv(args);
        await setSessionProxyEnv(env);
        say(dim("    已写入登录会话：从 Dock / Finder 打开的应用也会带上代理"));
      } catch (err) {
        say(`  ${warn(`写入登录会话失败：${err.message}`)}`);
      }
    }
    say(`\n  ${ok("已将转发服务安装为 launchd 常驻代理")}`);
    say(dim(`    ${plist}`));
    const status = await serviceStatus();
    say(`  ${status.running ? ok(`运行中（pid ${status.pid}）`) : warn("尚未运行")}`);
    say(dim(`    日志：~/.tunless/proxy.log`));
    say(dim(`    停止：tunless service stop；卸载：tunless service uninstall\n`));
    return status.running ? 0 : 1;
  }

  if (action === "uninstall") {
    await uninstallService();
    say(`\n  ${ok("转发服务已移除")}\n`);
    return 0;
  }

  // stop 是「停掉但保留安装」，不是卸载 —— 之前把它映射成
  // uninstallService，停一次就把 plist 删了，想再启动必须重装。
  if (action === "stop") {
    if (!(await serviceStatus()).installed) {
      say(`  ${warn("转发服务没有安装，没什么可停的")}`);
      return 1;
    }
    await stopService();
    say(`\n  ${ok("转发服务已停止")} ${dim("（登录会话变量已清除，避免应用指向死端口）")}`);
    say(dim("    再启动：tunless service start\n"));
    return 0;
  }

  if (action === "start") {
    if (!(await serviceStatus()).installed) {
      say(`  ${bad("转发服务还没安装，先 tunless service install")}`);
      return 1;
    }
    const st = await startService();
    say(
      st.running
        ? `\n  ${ok(`转发服务已启动（pid ${st.pid}）`)}\n`
        : `\n  ${bad("服务没有起来 — tunless service logs 看原因")}\n`,
    );
    return st.running ? 0 : 1;
  }

  if (action === "restart") {
    if (!(await serviceStatus()).installed) {
      say(`  ${bad("转发服务还没安装，先 tunless service install")}`);
      return 1;
    }
    const st = await restartService();
    say(
      st.running
        ? `\n  ${ok(`转发服务已重启（pid ${st.pid}）`)}\n`
        : `\n  ${bad("重启失败 — tunless service logs 看原因")}\n`,
    );
    return st.running ? 0 : 1;
  }

  if (action === "logs") {
    const text = readServiceLog(40);
    say(text ? text : dim("  暂无日志 — 用 tunless service install 启动"));
    return 0;
  }

  const status = await serviceStatus();
  const rep = createReporter({ out: say });
  rep.section("tunless 服务");
  rep.row(
    status.installed ? "ok" : "warn",
    "常驻代理",
    `${status.installed ? "launchd 已安装" : "尚未安装"}${status.plist ? ` · ${status.plist}` : ""}`,
  );
  if (status.installed) {
    rep.row(status.running ? "ok" : "bad", "运行状态", status.running ? `运行中（pid ${status.pid}）` : "已安装但未运行");
    if (status.staleCode) {
      rep.row(
        "warn",
        "代码版本",
        `守护进程跑的是 ${status.runtimeVersion ? `v${status.runtimeVersion}` : "旧版"}，已安装的是 v${packageVersion()} — tunless service restart`,
      );
    }
  }
  rep.suggest("tunless service install     # 开机自启，崩溃自动拉起");
  rep.suggest("tunless service start|stop|restart   # 启动 / 停止 / 重启");
  rep.suggest("tunless service uninstall   # 移除它");
  rep.suggest("tunless service logs\n");
  // 没在跑就是 1 —— 脚本里 `tunless service status && …` 才有意义
  return status.installed && status.running ? 0 : 1;
}

export async function cmdFix(args) {
  const internalDns = await resolveInternalDns(args.flags["internal-dns"], DEFAULT_INTERNAL_DNS);
  const assumeYes = args.flags.yes === true || args.flags.y === true;
  const frontend = await pickFrontend(args);
  const adapter = resolveAdapter(frontend);
  const rep = createReporter({ out: say });

  rep.section(`tunless 修复（${frontend.label}）`);

  // Surge / Stash 这类客户端没有可写的 mihomo 配置。不能先扫完再报错——
  // 那等于让用户白等一场，还以为工具快成功了。
  if (frontend.id !== "clash-verge-rev" && !frontend.configFile) {
    rep.row("bad", "内核配置", "没有找到可写的代理内核配置");
    if (frontend.runtimeOnly) {
      rep.dim(`${frontend.label} 的配置由 GUI 在运行时注入，磁盘上没有能改的配置文件`);
      rep.dim("DNS 分流请在客户端里自己加内网域名；转发代理不受影响");
    } else {
      rep.dim("这一步只对 mihomo 系客户端有效（Clash Verge / ClashX Meta / mihomo-party）");
    }
    rep.dim("你的客户端还能用 tunless proxy：转发照常工作，只是 DNS 分流得在客户端里自己配");
    rep.blank();
    return 1;
  }

  const { file: targetFile } = await adapter.prepare();
  const conn = await connect(frontend);
  const api = conn.api;
  rep.row("ok", "内核接口", api.descriptor);
  rep.line(info(`目标文件：${targetFile}`));

  // 内网 DNS 不通就没法分类，fix 的整个前提不成立 —— 趁早说清楚，
  // 而不是扫完几百个域名、每个都等满超时后报「没有内网域名」。
  const dnsAlive = await probeServer(internalDns);
  if (!dnsAlive.ok) {
    rep.blank();
    rep.row("bad", "内网 DNS", `${internalDns} 不可达（${dnsAlive.error}）`);
    rep.dim("不在公司网络时没法判断哪些是内网域名，本次无法修复");
    rep.suggest("连上公司网络 / VPN 后重跑，或用 --internal-dns 指定\n");
    return 1;
  }

  const repoRoots = args.flags.repos
    ? String(args.flags.repos).split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  const scanned = await scanAll({ repoRoots, includeChrome: args.flags["no-chrome"] !== true, logDir: frontend?.logDir ?? null });
  rep.line(info(`扫描到 ${scanned.hosts.length} 个候选域名`));

  const results = await probeDomains(scanned.hosts.map((h) => h.host), internalDns);
  const { internal, fake } = partitionByKind(results);
  void fake;

  if (!internal.length) {
    rep.row("warn", "内网域名", "未检测到 — 无需修复");
    return 0;
  }

  const suffixes = await validatedMerger(internalDns)(internal.map((r) => r.name));
  const existing = adapter.readCurrentDns();
  const dnsSection = buildDnsSection({
    internalDns,
    internalSuffixes: suffixes,
    existing,
  });

  const before = Object.keys(existing).length ? dumpYaml({ dns: existing }, 0) : "";
  const after = dumpYaml({ dns: dnsSection }, 0);

  rep.blank();
  rep.line(head("检测到的内网域名："));
  for (const r of internal.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 30)) {
    rep.dim(`${r.name.padEnd(50)} ${r.ips.join(", ")}`);
  }
  if (internal.length > 30) rep.dim(`…… 还有 ${internal.length - 30} 个`);

  rep.blank();
  rep.line(head(`将要配置的后缀（${suffixes.length}）：`));
  for (const s of suffixes) rep.dim(`+.${s}`);

  const diff = renderDiff(before, after);
  rep.blank();
  rep.line(head("配置差异："));
  if (diff.trim()) {
    for (const line of diff.split("\n")) {
      if (line.startsWith("+")) rep.line(paint(C.green, `  ${line}`));
      else if (line.startsWith("-")) rep.line(paint(C.red, `  ${line}`));
      else rep.dim(`  ${line}`);
    }
  } else {
    rep.dim("（无变化）");
  }

  if (!diff.trim()) {
    rep.row("ok", "配置", "已经是最新状态\n");
    return 0;
  }

  if (!assumeYes) {
    const answer = await prompt("确认应用这些改动？[y/N] ");
    if (!/^y(es)?$/i.test(answer.trim())) {
      rep.row("warn", "已取消", "未写入任何内容\n");
      return 1;
    }
  }

  const backup = backupDir();
  fs.mkdirSync(backup, { recursive: true });
  const backupFile = path.join(backup, path.basename(targetFile));
  fs.copyFileSync(targetFile, backupFile);
  rep.line(info(`备份：${backupFile}`));

  await adapter.apply(dnsSection);
  rep.row("ok", "配置", "已写入");

  rep.line(info(adapter.id === "clash-verge-rev" ? "正在重启 Clash Verge…" : "正在重载内核…"));
  // 重载失败必须回滚 —— 之前异常直接抛上去，文件改了、备份留了，
  // 用户只看到一句裸错误，配置停留在半生效状态。
  try {
    await adapter.reload(api);
  } catch (err) {
    rep.row("bad", "重载", err.message);
    fs.copyFileSync(backupFile, targetFile);
    rep.row("warn", "回滚", "已从备份恢复\n");
    return 1;
  }
  await new Promise((r) => setTimeout(r, adapter.id === "clash-verge-rev" ? 9000 : 2000));

  const verify = await verifyFix(
    internal.map((r) => r.name),
    suffixes,
    internalDns,
    api,
  );
  if (verify.ok) {
    rep.row("ok", "校验", "通过 — 内网域名均解析到私网地址");
    if (verify.warning) rep.row("warn", "校验", verify.warning);
    const checks = await Promise.all(
      internal.slice(0, 5).map((r) => httpCheck(r.name)),
    );
    for (const c of checks) {
      if (c.status) rep.dim(`${c.host} → HTTP ${c.status}`);
      else rep.dim(`${c.host} → ${c.error} (HTTP check is advisory only)`);
    }
    rep.blank();
    return 0;
  }

  rep.row("bad", "校验", `失败：${verify.reason}`);
  rep.line(info(`正在从备份恢复：${backupFile}`));
  fs.copyFileSync(backupFile, targetFile);
  try {
    await adapter.reload(api);
  } catch {
    rep.dim("（重载失败 — 请手动重启代理客户端）");
  }
  rep.row("warn", "回滚", "已回滚\n");
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

  // fake-ip 只能走「内核自己 / 系统解析器」这条通道验证 —— 内网 DNS
  // 永远不会回 198.18.x，之前拿它查等于没查，校验形同虚设。
  const resolveCore = api
    ? async (name) => {
        try {
          return await api.dnsAnswers(name);
        } catch {
          return null;
        }
      }
    : async (name) => {
        const res = await resolve4System(name);
        return res.ok ? res.ips : null;
      };

  let inconclusive = 0;
  const names = [...new Set([...suffixes, ...hosts.slice(0, 10)])];
  for (const name of names) {
    const ips = await resolveCore(name);
    if (ips === null) {
      inconclusive += 1;
      continue;
    }
    if (ips.some((ip) => ip.startsWith("198.18."))) {
      return { ok: false, reason: `内核仍在给 ${name} 回假地址（fake-ip-filter 没生效）` };
    }
  }

  // 全部查不到不代表通过 —— 内核可能还在重启。如实说「没验完」，
  // 而不是假装校验通过。
  const warning =
    inconclusive > 0
      ? `${inconclusive} 个域名没能向${api ? "内核" : "系统解析器"}核实（可能还在重启），请稍后观察`
      : null;
  return { ok: true, warning };
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
${head("tunless")} — 让 Agent 不用开 TUN 也能联网

${head("用法")}
  tunless                     启动图形界面（TUI）
  tunless doctor [选项]       诊断环境、程序与内网域名
  tunless scan [选项]         列出候选域名及其解析结果
  tunless fix [选项]          生成方案 → 预览差异 → 确认 → 应用 → 校验
  tunless proxy [选项]        启动本地转发代理，把代理能力交给工具
  tunless launch [应用]       带代理环境重启某个应用（支持 Antigravity / Cursor / Codex）
  tunless cursor              给 Cursor 配好代理并带代理重启（专治模型连不上）
  tunless rules [操作]        add | remove | list — 手动补充内网域名/关键词/IP 段
  tunless service <操作>      install | start | stop | restart | status | logs | uninstall
  tunless upstream [操作]     status | set <host:port> | clear — 指定上游代理
  tunless test [应用]         按该应用实际会连的域名测外网
  tunless targets [操作]      add | remove | list — 自定义测试目标
  tunless restore [序号]      列出配置备份，并还原到指定那份
  tunless env                查看写进登录会话的代理变量（clear 撤销）

${head("选项")}
  --internal-dns <ip>   内网 DNS 服务器（默认自动发现，兜底 ${DEFAULT_INTERNAL_DNS}）
  --repos <路径>        逗号分隔的仓库根目录，用于扫描域名
  --no-chrome           跳过 Chrome 历史记录（需要完全磁盘访问权限）
  --frontend <id>       指定前端：clash-verge-rev | generic-mihomo
  --upstream <host:port> 手动指定上游代理（临时覆盖，不落盘；按实际 HTTP/SOCKS 能力使用）
  --internal-fallback refuse|upstream
                    内网后缀解析失败、假 IP 或公网地址时的策略。
                    refuse（默认）返回 502，不把该域名发给上游。
                    upstream 显式改走上游，域名会泄露给代理。
  --config <路径>       指定配置文件（通用前端）
  --port <n>            HTTP 代理端口（默认 8899）
  --socks-port <n>      SOCKS5 代理端口（默认 8898，设为 0 则禁用）
  --print-env           只打印环境变量后退出
  --no-scan             仅使用客户端配置，不做实时扫描
  --app <名称>          要启动的应用（默认 Antigravity）
  --write-settings      同时写入应用的代理配置（Codex 写 ~/.codex/.env）
  --yes, -y             跳过确认提示
  --help, -h            显示帮助

${head("示例")}
  tunless
  tunless doctor
  tunless scan --repos ~/company
  tunless fix --yes
  tunless proxy
  tunless launch Antigravity
  tunless launch Cursor --write-settings
  tunless cursor
  tunless rules add '+.17usoft.com'
  tunless rules add 10.0.0.0/8
  tunless upstream set 127.0.0.1:7897
  tunless test antigravity
  tunless targets add api.example.com:8443/health
`;

export async function main(argv) {
  const args = parseArgs(argv);
  const cmd = args._[0];

  if (args.flags.help || args.flags.h) {
    console.log(HELP);
    return 0;
  }

  if (args.flags.version) {
    console.log(packageVersion());
    return 0;
  }

  if (!cmd || cmd === "tui" || cmd === "ui") {
    if (!process.stdout.isTTY) {
      // 没有交互式终端时退化成纯文本输出，方便在管道里看状态。
      const { renderStaticSummary } = await import("./tui/app.js");
      console.log(
        await renderStaticSummary({
          internalDns: args.flags["internal-dns"] ?? null,
          repoRoots: args.flags.repos
            ? String(args.flags.repos).split(",").map((s) => s.trim()).filter(Boolean)
            : [],
          includeChrome: args.flags["no-chrome"] !== true,
        }),
      );
      return 0;
    }
    const { runTui } = await import("./tui/app.js");
    return await runTui({
      internalDns: args.flags["internal-dns"] ?? null,
      repoRoots: args.flags.repos
        ? String(args.flags.repos).split(",").map((s) => s.trim()).filter(Boolean)
        : [],
      includeChrome: args.flags["no-chrome"] !== true,
    });
  }

  try {
    switch (cmd) {
      case "doctor":
        return await cmdDoctor(args);
      case "scan":
        return await cmdScan(args);
      case "fix":
        return await cmdFix(args);
      case "proxy":
        return await cmdProxy(args);
      case "service":
        return await cmdService(args);
      case "upstream":
        return await cmdUpstream(args);
      case "test":
        return await cmdTest(args);
      case "targets":
        return await cmdTargets(args);
      case "restore":
        return await cmdRestore(args);
      case "env":
        return await cmdEnv(args);
      case "launch":
        return await cmdLaunch(args);
      case "cursor":
        return await cmdCursor(args);
      case "rules": {
        const { cmdRules } = await import("./cli-rules.js");
        return await cmdRules(args, {
          say: (line = "") => say(line),
          ok,
          warn,
          info,
          dim,
        });
      }
      default:
        console.error(`未知命令：${cmd}`);
        say(HELP);
        return 1;
    }
  } catch (err) {
    console.error(bad(`\n${err.message}\n`));
    if (process.env.TUNLESS_DEBUG) console.error(err.stack);
    return 1;
  }
}
