// 仪表盘与 CLI 共用的子系统判词 —— 纯函数。
// 「系统健不健康」只有这一种说法，TUI 和 doctor 不再各讲各的。
// 输入是 src/tui/state.js 的 collectState 产出（或其子集）。

import { describeEgress } from "./egress.js";

export const ROW_ORDER = ["service", "upstream", "tools", "internal"];

const LABEL = { service: "服务", upstream: "上游", tools: "工具", internal: "内网" };

function row(id, status, detail, action = null) {
  return { id, status, label: LABEL[id], detail, action };
}

function serviceRow(state) {
  const s = state?.sidecar ?? {};
  if (state?.loading) return row("service", "unknown", "探测中");
  if (s.running) {
    // 守护进程跑的不是当前安装版 —— 界面功能全在，代码却是旧的。
    // 「升了级怎么还没好」九成是这个，必须喊出来。
    if (s.staleCode) {
      const ver = s.runtimeVersion ? `v${s.runtimeVersion}` : "旧版";
      const cur = state?.pkgVersion ? `v${state.pkgVersion}` : "当前版";
      return row("service", "warn",
        `运行中 pid ${s.pid ?? "?"}，但跑的是 ${ver}（已安装 ${cur}）`, "tunless service restart");
    }
    return row("service", "ok",
      [`运行中${s.pid ? ` pid ${s.pid}` : ""}`, `HTTP :${s.httpPort ?? 8899}`, s.socksPort ? `SOCKS :${s.socksPort}` : null]
        .filter(Boolean).join(" · "));
  }
  if (s.installed) return row("service", "bad", "已停止", "按 s 启动");
  return row("service", "warn", "未安装", "按 g 进向导装上");
}

function upstreamRow(state) {
  const u = state?.upstream ?? {};
  if (state?.loading) return row("upstream", "unknown", "探测中");
  if (u.chosen) {
    const addr = `${u.chosen.host}:${u.chosen.port}`;
    // drift 本身就是完整原因句（「你固定的 A 还是旧客户端在用，系统代理
    // 已经切到 B」），两个端口号都在里面。
    if (u.drift) return row("upstream", "warn", u.drift, "按 u 确认");
    const note = describeEgress(state?.egress);
    // detail 常自带地址（「127.0.0.1:6478 · 系统代理（HTTP）」），
    // 前缀再拼一遍就重复了 —— 以 detail 开头是地址时直接用 detail。
    const tagged = u.detail?.startsWith(addr) ? u.detail : `${addr}${u.detail ? ` · ${u.detail}` : ""}`;
    if (note) {
      return row("upstream", note.restricted ? "warn" : "ok", `${tagged} · ${note.text}`);
    }
    return row("upstream", "ok", tagged);
  }
  return row("upstream", "bad", "没找到可用上游", "按 u 手动选");
}

function toolsRow(state) {
  const apps = (state?.apps ?? []).filter((a) => a.installed);
  if (state?.loading) return row("tools", "unknown", "探测中");
  if (!apps.length) return row("tools", "warn", "没检测到支持的工具", "装 Antigravity / Cursor");
  const parts = apps.map((a) =>
    a.proxied === "ok" ? `${a.name} 代理中`
      : a.proxied === "stale" ? `${a.name} ⚠旧代理`
      : a.proxied === "probe-error" ? `${a.name} ?未测出`
      : a.running ? `${a.name} 未走代理`
      : `${a.name} —`);
  const stale = apps.some((a) => a.proxied === "stale");
  const proxied = apps.some((a) => a.proxied === "ok");
  return row(
    "tools",
    stale ? "warn" : proxied ? "ok" : "unknown",
    parts.join(" · "),
    stale ? "回车看详情" : null,
  );
}

function internalRow(state) {
  if (state?.loading) return row("internal", "unknown", "探测中");
  // bad 先判：手拼状态喂进来时，重症不能被轻症（DNS 死的 warn）盖掉。
  if ((state?.fakeCount ?? 0) > 0)
    return row("internal", "bad", `${state?.fakeCount} 个内网后缀仍是假 IP`, "按 f 修复");
  if (state?.dnsAlive === false)
    return row("internal", "warn", `内网 DNS ${state?.internalDns ?? ""} 不可达`);
  const s = state?.sidecar ?? {};
  const active = s.activeSuffixes?.length ?? 0;
  const pending = s.pendingSuffixes?.length ?? 0;
  if (s.running) {
    const domainCount = state.internalDomains?.length ?? 0;
    return pending
      ? row("internal", "warn", `${active} 后缀分流中 · ${pending} 个待重启生效`, "d 查看")
      : row("internal", "ok", `${active} 后缀分流中${domainCount ? ` · ${domainCount} 域名` : ""}`);
  }
  const total = state.suffixes?.length ?? state.internalDomains?.length ?? 0;
  return total
    ? row("internal", "warn", `${total} 个待分流（服务未启动）`, "s 启动服务")
    : row("internal", "unknown", "没有内网域名需要分流");
}

/**
 * 主屏五行。网络隧道和模型验证分开，403/429 和国家样本都不能写成可用。
 */
export function overviewLines(state, { app = null, reach = null } = {}) {
  const side = state?.sidecar ?? {};
  const listen = state?.loading
    ? line("listen", "unknown", "转发服务", "探测中")
    : line(
        "listen",
        side.running && side.httpOpen ? "ok" : side.running ? "warn" : side.installed ? "bad" : "warn",
        "转发服务",
        [
          side.running ? `pid ${side.pid ?? "?"}` : side.installed ? "已停止" : "未安装",
          `HTTP ${side.httpOpen ? "开" : "关"} :${side.httpPort ?? 8899}`,
          `SOCKS ${side.socksOpen ? "开" : "关"} :${side.socksPort ?? 8898}`,
        ].join(" · "),
      );

  const chosen = state?.upstream?.chosen;
  const authOnly = (state?.upstream?.candidates ?? []).filter(
    (c) => c.authRequired?.length && !c.protocols?.length,
  );
  let upstream;
  if (state?.loading) upstream = line("upstream", "unknown", "上游代理", "探测中");
  else if (state?.upstream?.drift) upstream = line("upstream", "warn", "上游代理", state.upstream.drift);
  else if (chosen?.authRequired?.length && !chosen?.protocols?.length) {
    upstream = line(
      "upstream",
      "warn",
      "上游代理",
      `${chosen.host}:${chosen.port} 需要认证（${chosen.authRequired.join("+")}），未使用`,
    );
  } else if (chosen?.protocols?.length) {
    const note = describeEgress(state?.egress);
    upstream = line(
      "upstream",
      note?.restricted ? "warn" : "ok",
      "上游代理",
      `${chosen.host}:${chosen.port} ${chosen.protocols.join("+")}${note ? ` · ${note.text}` : ""}`,
    );
  } else if (authOnly.length) {
    const c = authOnly[0];
    upstream = line(
      "upstream",
      "warn",
      "上游代理",
      `${c.host}:${c.port} 需要认证（${c.authRequired.join("+")}），未使用`,
    );
  } else upstream = line("upstream", "bad", "上游代理", "没有免认证的 HTTP/SOCKS");

  let appLine;
  if (!app) appLine = line("app", "unknown", "应用路径", "还没选工具");
  else if (app.proxied === "ok") appLine = line("app", "ok", "应用路径", `${app.name} 观察到连着本机代理`);
  else if (app.proxied === "stale") appLine = line("app", "warn", "应用路径", `${app.name} 还连着别的本地端口`);
  else if (app.proxied === "probe-error") appLine = line("app", "unknown", "应用路径", `${app.name} 连接没读到`);
  else if (!app.running) appLine = line("app", "unknown", "应用路径", `${app.name} 没在运行，没有连接证据`);
  else appLine = line("app", "unknown", "应用路径", `${app.name} 在运行，此刻没有代理连接`);

  const codes = (reach?.results ?? [])
    .map((r) => r.httpStatus)
    .filter((code) => Number.isFinite(code));
  let netLine;
  let modelLine;
  if (!reach) {
    netLine = line("net", "unknown", "网络隧道", "还没测");
    modelLine = line("model", "unknown", "模型", "未验证，没有账号调用");
  } else if (reach.serviceVerified) {
    netLine = line("net", "ok", "网络隧道", "已到达对端");
    modelLine = line("model", "ok", "模型", "这次调用已验证");
  } else if (reach.ok) {
    netLine = line(
      "net",
      "warn",
      "网络隧道",
      `已到达${codes.length ? `，HTTP ${codes.join("/")}` : ""}。401/403/429 不是可用`,
    );
    modelLine = line("model", "unknown", "模型", "未验证");
  } else {
    netLine = line("net", "bad", "网络隧道", "没建立。这不等于模型被拒绝");
    modelLine = line("model", "unknown", "模型", "未验证");
  }

  const internal = rowsFor(state).find((r) => r.id === "internal");
  return [listen, upstream, appLine, netLine, modelLine, { ...internal, label: "内网分流" }];
}

function line(id, status, label, detail) {
  return { id, status, label, detail };
}

export function rowsFor(state) {
  return ROW_ORDER.map((id) =>
    ({ service: serviceRow, upstream: upstreamRow, tools: toolsRow, internal: internalRow })[id](state));
}

/** 顶部总判决：bad 优先于 warn；全 unknown 是「探测中」不是故障。 */
export function verdictFor(state) {
  const rows = rowsFor(state);
  if (state?.loading || rows.every((r) => r.status === "unknown"))
    return { tone: "info", text: "正在探测…" };
  const bad = rows.filter((r) => r.status === "bad").length;
  if (bad) return { tone: "bad", text: `${bad} 处故障` };
  const warn = rows.filter((r) => r.status === "warn").length;
  if (warn) return { tone: "warn", text: `${warn} 处需要注意` };
  if (rows.every((r) => r.status === "ok")) return { tone: "ok", text: "一切正常" };
  return { tone: "ok", text: "正常" };
}
