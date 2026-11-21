// TUI 的数据采集层：把各核心模块的探测结果汇总成界面可以直接渲染的状态。
// 所有探测都是异步且相互独立的，失败不影响其它面板。

import { discoverAll, systemProxyState, resolveInternalDns } from "../core/discover.js";
import {
  discoverUpstream,
  loadPinnedUpstream,
  describeCandidate,
  detectClient,
  detectPinnedDrift,
  detectActiveClient,
} from "../core/upstream.js";
import { probeApi } from "../core/api.js";
import { classifyDomain, probeServer, resolve4System } from "../core/dns.js";
import { scanAll } from "../core/scan.js";
import { inspectProcesses } from "../core/proc.js";
import { serviceStatus } from "../core/launchd.js";
import { detectEgress } from "../core/egress.js";
import { mergeHostsValidated, partitionByKind } from "../core/plan.js";
import { loadRules, ruleSuffixes, loadLearnedSuffixes, learnSuffixes } from "../core/rules.js";
import { readRuntime, packageVersion } from "../core/paths.js";
import { APPS, isAppInstalled, appVersion, cliVersion, mainPid, appProxyPorts, proxyVerdict } from "../core/apps.js";
import net from "node:net";

const DEFAULT_INTERNAL_DNS = "10.249.150.130";

async function probePort(host, port, timeout = 1200) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeout, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

// 受控并发地执行异步任务，避免一次性发出过多 DNS 查询。
async function probeConcurrently(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(runners);
  return results;
}

export function emptyState() {
  return {
    loading: true,
    frontend: null,
    core: { reachable: false, version: null, error: null, tun: false, mixedPort: null, mode: null },
    systemProxy: null,
    upstream: {
      pinned: null,
      chosen: null,
      candidates: [],
      detail: "",
      drift: null,
    },
    egress: null,
    sidecar: {
      running: false,
      installed: false,
      pid: null,
      httpPort: 8899,
      socksPort: 8898,
      httpOpen: false,
      socksOpen: false,
      runtime: null,
      runtimeVersion: null,
      staleCode: false,
      activeSuffixes: [],
      pendingSuffixes: [],
    },
    pkgVersion: null,
    internalDns: null,
    dnsAlive: null,
    internalDomains: [],
    apps: [],
    reachability: null,
    publicCount: 0,
    fakeCount: 0,
    unresolvedCount: 0,
    suffixes: [],
    processes: [],
    notes: [],
    errors: [],
    rules: { domain: [], keyword: [], cidr: [] },
    updatedAt: null,
  };
}

export async function collectState({
  internalDns: internalDnsFlag = null,
  repoRoots = [],
  includeChrome = false,
  onProgress = null,
  signal = null,
} = {}) {
  const cancelled = () => {
    if (!signal?.aborted) return;
    const err = new Error("检测已取消");
    err.name = "AbortError";
    throw err;
  };
  const state = emptyState();
  state.loading = true;
  state.rules = loadRules();
  const notify = (stage) => {
    if (signal?.aborted) return;
    if (onProgress) {
      try {
        onProgress(stage, state);
      } catch {
        // 进度回调出错不应影响采集
      }
    }
  };

  // 内网 DNS：显式参数 > 系统自动发现 > 兜底。换网络环境不用重配。
  cancelled();
  const internalDns = await resolveInternalDns(internalDnsFlag, DEFAULT_INTERNAL_DNS);
  cancelled();
  state.internalDns = internalDns;

  const frontends = discoverAll();

  // 第一段：彼此独立的轻量探测一起发出去 —— 之前全串行，
  // 冷启动要 7~9 秒。
  notify("正在探测环境…");
  const [active, detected, sysProxy, svc] = await Promise.all([
    detectActiveClient(),
    detectClient(),
    systemProxyState(),
    serviceStatus(),
  ]);
  state.systemProxy = sysProxy;

  // 以「系统代理当前指向的端口」为准判断用户正在用哪个客户端：
  // 机器上装着好几个客户端时，只看目录会一直显示旧的那个。
  const frontend =
    (active ? frontends.find((f) => f.id === active.id) : null) ??
    frontends.find((f) => f.id === "clash-verge-rev" && f.home) ??
    frontends[frontends.length - 1];
  // 用户可能用 Surge / Stash —— 这些客户端没有可读的 mihomo 配置，
  // 但进程名能认出来，界面就别再显示「Generic mihomo」了。
  // 只有「没认出是哪个 mihomo 系」时才用进程名兜底，避免把 Verge 的
  // merge 文件能力显示成别的客户端。
  state.frontend =
    active
      ? { ...frontend, label: active.label, detected: true }
      : detected && frontend.id !== "clash-verge-rev"
        ? { ...frontend, label: detected.label, detected: true }
        : frontend;

  // 转发服务状态
  state.sidecar.running = svc.running;
  state.sidecar.installed = svc.installed;
  state.sidecar.pid = svc.pid;
  state.sidecar.runtimeVersion = svc.runtimeVersion ?? null;
  state.sidecar.staleCode = Boolean(svc.staleCode);
  state.pkgVersion = packageVersion();

  // 第二段：内核接口、应用探测、端口探活、域名扫描、进程检查并发跑。
  // 域名分类前先用一次活性探测确认内网 DNS 活着 —— 不通就跳过整段，
  // 不然几百个域名每个都等满超时，界面卡死在「正在扫描域名」。
  notify("正在扫描…");
  const dnsAlive = await probeServer(internalDns);
  state.dnsAlive = dnsAlive.ok;

  cancelled();
  const [coreResult, appsResult, portsResult, scanResult, procsResult] = await Promise.all([
    // 内核连通性
    (async () => {
      try {
        const conn = await probeApi(frontend.apiCandidates, { signal });
        const cfg = await conn.api.configs();
        return {
          reachable: true,
          version: conn.info.version,
          tun: Boolean(cfg.tun?.enable),
          mixedPort: cfg["mixed-port"] ?? null,
          mode: cfg.mode ?? null,
          error: null,
          failures: [],
        };
      } catch (err) {
        if (err.name === "AbortError" || signal?.aborted) throw err;
        return { reachable: false, error: err.message, failures: err.failures ?? [] };
      }
    })(),
    // 已安装的应用：第一步「选工具」要靠它。
    Promise.all(
      APPS.map(async (app) => {
        const installed = await isAppInstalled(app);
        const pid = installed ? await mainPid(app) : null;
        // 在跑就顺手看它现在连的哪个代理 —— 「这个工具已经修好了」
        // 是选工具那一步最该看到的信息，比版本号有用。
        let proxied = null;
        if (pid) {
          try {
            const conn = await appProxyPorts(app);
            // 探测本身失败（lsof 超时/被掐）和「探测成功但没连接」是两回事：
            // 前者说「没测出来」，后者才是「没走代理」——混着说会谎报。
            const verdict = conn.error
              ? { state: "probe-error", ports: conn.ports }
              : proxyVerdict(conn, state.sidecar.httpPort);
            proxied = verdict.state;
          } catch {
            proxied = null;
          }
        }
        return {
          id: app.id,
          name: app.name,
          description: app.description,
          installed,
          running: Boolean(pid),
          proxied,
          version: app.bin ? cliVersion(app) : appVersion(app.bundle),
        };
      }),
    ).catch((err) => {
      state.errors.push(`应用检测失败 — ${err.message}`);
      return [];
    }),
    // 转发端口
    Promise.all([
      probePort("127.0.0.1", state.sidecar.httpPort),
      probePort("127.0.0.1", state.sidecar.socksPort),
    ]),
    // 域名扫描与解析
    (async () => {
      if (!dnsAlive.ok) {
        return {
          scanned: 0,
          internal: [],
          suffixes: [],
          fake: 0,
          publicCount: 0,
          unresolvedCount: 0,
          notes: [`内网 DNS ${internalDns} 不可达（${dnsAlive.error}），跳过域名分类`],
        };
      }
      const scanned = await scanAll({ repoRoots, includeChrome, logDir: frontend?.logDir ?? null });
      const hosts = scanned.hosts.map((h) => h.host);
      // 限制并发，几百个 UDP 查询同时发出会把机器打满
      const results = await probeConcurrently(hosts, 24, (host) =>
        classifyDomain(host, internalDns),
      );
      const { internal, publicHosts, unresolved } = partitionByKind(results);
      const suffixes = await mergeHostsValidated(
        internal.map((r) => r.name),
        { classify: (name) => classifyDomain(name, internalDns) },
      );
      return {
        scanned: hosts.length,
        internal: internal.map((r) => ({ name: r.name, ips: r.ips })),
        suffixes,
        publicCount: publicHosts.length,
        unresolvedCount: unresolved.length,
        notes: scanned.notes,
      };
    })().catch((err) => {
      state.errors.push(`域名扫描失败 — ${err.message}`);
      return { scanned: 0, internal: [], suffixes: [], publicCount: 0, unresolvedCount: 0, notes: [] };
    }),
    // 进程代理能力
    inspectProcesses().catch((err) => {
      state.errors.push(`进程检测失败 — ${err.message}`);
      return [];
    }),
  ]);

  if (coreResult.reachable) {
    state.core.reachable = true;
    state.core.version = coreResult.version;
    state.core.tun = coreResult.tun;
    state.core.mixedPort = coreResult.mixedPort;
    state.core.mode = coreResult.mode;
  } else {
    state.core.error = coreResult.error;
    for (const f of coreResult.failures) {
      const where = f.candidate.socketPath
        ? `unix://${f.candidate.socketPath}`
        : `http://${f.candidate.host}:${f.candidate.port}`;
      state.errors.push(`${where} — ${f.error}`);
    }
  }

  state.apps = appsResult;
  state.sidecar.httpOpen = portsResult[0];
  state.sidecar.socksOpen = portsResult[1];
  // launchd 的状态可能滞后：任务已 bootout 但 print 仍报 running，
  // 也可能 KeepAlive 正在拉起。以端口是否真的监听为准。
  if (state.sidecar.running && !state.sidecar.httpOpen && !state.sidecar.socksOpen) {
    state.sidecar.running = false;
    state.sidecar.pid = null;
  }

  state.internalDomains = scanResult.internal.sort((a, b) => a.name.localeCompare(b.name));
  state.publicCount = scanResult.publicCount;
  state.unresolvedCount = scanResult.unresolvedCount;
  state.notes = scanResult.notes;
  state.processes = procsResult;

  cancelled();
  // 第三段：上游探测（需要 mixedPort）+ fake-ip 检查（需要后缀）。
  notify("正在探测上游代理…");
  state.upstream.pinned = loadPinnedUpstream();
  const learned = learnSuffixes(scanResult.suffixes);

  const suffixSet = new Set([...learned.all, ...ruleSuffixes(state.rules)]);
  state.suffixes = [...suffixSet].sort();

  const [upstreamResult, fakeResult] = await Promise.all([
    (async () => {
      try {
        const found = await discoverUpstream({
          mixedPort: state.core.mixedPort,
          timeoutMs: 900,
        });
        const candidates = found.candidates.filter((c) => c.isProxy);
        const pinned = state.upstream.pinned;
        if (pinned) {
          // 端口还活着不代表它还是你现在的客户端。
          const drift = await detectPinnedDrift({ pinned });
          if (drift.stale) {
            return {
              candidates,
              chosen: {
                host: drift.replacement.host,
                port: drift.replacement.port,
                protocols: drift.replacement.protocols,
              },
              detail:
                `${drift.replacement.host}:${drift.replacement.port}` +
                `${drift.replacement.label ? ` · ${drift.replacement.label}` : ""}（你固定的 ${pinned.port} 已过期）`,
              drift: drift.reason,
            };
          }
          const match = candidates.find(
            (c) => c.port === pinned.port && c.host === pinned.host,
          );
          return {
            candidates,
            chosen: {
              host: pinned.host,
              port: pinned.port,
              protocols: match?.protocols ?? [],
            },
            detail: match ? `${describeCandidate(match)}（已固定）` : `手动固定 ${pinned.host}:${pinned.port}`,
          };
        }
        return {
          candidates,
          chosen: found.upstream,
          detail: found.chosen ? describeCandidate(found.chosen) : "",
        };
      } catch (err) {
        state.errors.push(`上游探测失败 — ${err.message}`);
        return { candidates: [], chosen: null, detail: "" };
      }
    })(),
    // fake-ip 只能走系统解析器看 —— 内网 DNS 永远不会回 198.18.x，
    // 之前那一路查出来永远是 0，等于没查。
    (async () => {
      if (!dnsAlive.ok || !state.suffixes.length) return 0;
      const checks = await probeConcurrently(state.suffixes, 8, async (s) => {
        const res = await resolve4System(s);
        return res.ips?.some((ip) => ip.startsWith("198.18.")) ? 1 : 0;
      });
      return checks.reduce((a, b) => a + b, 0);
    })().catch(() => 0),
  ]);

  state.upstream.candidates = upstreamResult.candidates;
  state.upstream.chosen = upstreamResult.chosen;
  state.upstream.detail = upstreamResult.detail;
  state.upstream.drift = upstreamResult.drift ?? null;
  state.fakeCount = fakeResult;

  // 出口地区：连通只能证明「能出网」，模型目录全不全看出口在哪。
  // 15 分钟缓存，首轮探测多花 ~1s，之后免费。
  if (state.upstream.chosen) {
    try {
      state.egress = await detectEgress(state.upstream.chosen);
    } catch {
      state.egress = null;
    }
  }

  // 运行中的服务实际加载了什么 —— 和「刚算出来的」区分开，
  // 不然界面会把还没生效的域名说成「已分流」。
  const runtime = readRuntime();
  if (runtime && state.sidecar.running) {
    state.sidecar.runtime = runtime;
    state.sidecar.activeSuffixes = runtime.suffixes ?? [];
    state.sidecar.pendingSuffixes = state.suffixes.filter(
      (s) => !state.sidecar.activeSuffixes.includes(s),
    );
  } else {
    state.sidecar.runtime = null;
    state.sidecar.activeSuffixes = [];
    state.sidecar.pendingSuffixes = state.suffixes;
  }

  cancelled();
  state.loading = false;
  state.updatedAt = new Date();
  notify("完成");
  return state;
}
