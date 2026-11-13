// TUI 的数据采集层：把各核心模块的探测结果汇总成界面可以直接渲染的状态。
// 所有探测都是异步且相互独立的，失败不影响其它面板。

import { discoverAll, systemProxyState } from "../core/discover.js";
import {
  discoverUpstream,
  loadPinnedUpstream,
  describeCandidate,
  detectClient,
} from "../core/upstream.js";
import { probeApi } from "../core/api.js";
import { classifyDomain } from "../core/dns.js";
import { scanAll } from "../core/scan.js";
import { inspectProcesses } from "../core/proc.js";
import { serviceStatus } from "../core/launchd.js";
import { mergeHostsValidated, partitionByKind } from "../core/plan.js";
import { loadRules, ruleSuffixes } from "../core/rules.js";
import { APPS, isAppInstalled, appVersion, cliVersion, mainPid } from "../core/apps.js";
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
    },
    sidecar: {
      running: false,
      installed: false,
      pid: null,
      httpPort: 8899,
      socksPort: 8898,
      httpOpen: false,
      socksOpen: false,
    },
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
  internalDns = DEFAULT_INTERNAL_DNS,
  repoRoots = [],
  includeChrome = false,
  onProgress = null,
} = {}) {
  const state = emptyState();
  state.loading = true;
  state.rules = loadRules();
  const notify = (stage) => {
    if (onProgress) {
      try {
        onProgress(stage, state);
      } catch {
        // 进度回调出错不应影响采集
      }
    }
  };

  const frontends = discoverAll();
  const verge = frontends.find((f) => f.id === "clash-verge-rev" && f.home);
  const frontend = verge ?? frontends[frontends.length - 1];
  // 用户可能用 Surge / Stash —— 这些客户端没有可读的 mihomo 配置，
  // 但进程名能认出来，界面就别再显示「Generic mihomo」了。
  // 只有「没认出是哪个 mihomo 系」时才用进程名兜底，避免把 Verge 的
  // merge 文件能力显示成别的客户端。
  const detected = await detectClient();
  state.frontend =
    detected && frontend.id !== "clash-verge-rev"
      ? { ...frontend, label: detected.label, detected: true }
      : frontend;

  // 内核连通性
  try {
    const conn = await probeApi(frontend.apiCandidates);
    state.core.reachable = true;
    state.core.version = conn.info.version;
    const cfg = await conn.api.configs();
    state.core.tun = Boolean(cfg.tun?.enable);
    state.core.mixedPort = cfg["mixed-port"] ?? null;
    state.core.mode = cfg.mode ?? null;
  } catch (err) {
    state.core.error = err.message;
    for (const f of err.failures ?? []) {
      const where = f.candidate.socketPath
        ? `unix://${f.candidate.socketPath}`
        : `http://${f.candidate.host}:${f.candidate.port}`;
      state.errors.push(`${where} — ${f.error}`);
    }
  }

  notify("正在检测系统代理…");
  state.systemProxy = await systemProxyState();

  // 上游代理与客户端类型无关：系统代理、已知进程端口、内核混合端口都算候选。
  notify("正在探测上游代理…");
  try {
    state.upstream.pinned = loadPinnedUpstream();
    const found = await discoverUpstream({
      mixedPort: state.core.mixedPort,
      timeoutMs: 900,
    });
    state.upstream.candidates = found.candidates.filter((c) => c.isProxy);
    state.upstream.chosen = found.upstream;
    state.upstream.detail = found.chosen ? describeCandidate(found.chosen) : "";
  } catch (err) {
    state.errors.push(`上游探测失败 — ${err.message}`);
  }

  // 已安装的应用：第一步「选工具」要靠它。
  try {
    state.apps = await Promise.all(
      APPS.map(async (app) => {
        const installed = await isAppInstalled(app);
        const pid = installed ? await mainPid(app) : null;
        return {
          id: app.id,
          name: app.name,
          description: app.description,
          installed,
          running: Boolean(pid),
          version: app.bin ? cliVersion(app) : appVersion(app.bundle),
        };
      }),
    );
  } catch (err) {
    state.errors.push(`应用检测失败 — ${err.message}`);
  }

  // 转发服务
  try {
    const svc = await serviceStatus();
    state.sidecar.running = svc.running;
    state.sidecar.installed = svc.installed;
    state.sidecar.pid = svc.pid;
  } catch {
    // 未安装时忽略
  }
  const httpOpen = await probePort("127.0.0.1", state.sidecar.httpPort);
  const socksOpen = await probePort("127.0.0.1", state.sidecar.socksPort);
  state.sidecar.httpOpen = httpOpen;
  state.sidecar.socksOpen = socksOpen;
  // launchd 的状态可能滞后：任务已 bootout 但 print 仍报 running，
  // 也可能 KeepAlive 正在拉起。以端口是否真的监听为准。
  if (state.sidecar.running && !httpOpen && !socksOpen) {
    state.sidecar.running = false;
    state.sidecar.pid = null;
  }

  notify("正在扫描域名…");
  // 域名扫描与解析。DNS 探测数量多、耗时长，这里限制并发，
  // 避免几百个 UDP 查询同时发出把机器打满、拖慢整个界面。
  try {
    const scanned = await scanAll({ repoRoots, includeChrome });
    state.notes = scanned.notes;
    const hosts = scanned.hosts.map((h) => h.host);
    const results = await probeConcurrently(hosts, 24, (host) =>
      classifyDomain(host, internalDns),
    );
    notify("正在归并后缀…");
    const { internal, fake, publicHosts, unresolved } = partitionByKind(results);
    state.internalDomains = internal
      .map((r) => ({ name: r.name, ips: r.ips }))
      .sort((a, b) => a.name.localeCompare(b.name));
    state.fakeCount = fake.length;
    state.publicCount = publicHosts.length;
    state.unresolvedCount = unresolved.length;

    state.suffixes = await mergeHostsValidated(
      state.internalDomains.map((d) => d.name),
      { classify: (name) => classifyDomain(name, internalDns) },
    );
    // 用户手写的域名规则同样要参与路由，界面里也要能看到它们生效了。
    state.suffixes = [...new Set([...state.suffixes, ...ruleSuffixes(state.rules)])].sort();
  } catch (err) {
    state.errors.push(`域名扫描失败 — ${err.message}`);
  }

  notify("正在检测程序代理能力…");
  // 进程代理能力
  try {
    state.processes = await inspectProcesses();
  } catch (err) {
    state.errors.push(`进程检测失败 — ${err.message}`);
  }

  state.loading = false;
  state.updatedAt = new Date();
  notify("完成");
  return state;
}
