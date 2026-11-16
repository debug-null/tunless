// 仪表盘与 CLI 共用的子系统判词 —— 纯函数、零依赖。
// 「系统健不健康」只有这一种说法，TUI 和 doctor 不再各讲各的。
// 输入是 src/tui/state.js 的 collectState 产出（或其子集）。

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
    // 出口地区受限：能出网，但 AI 模型目录会被服务端按地区裁剪 ——
    // 「Gemini/Claude/GPT 不见了」的病根，比端口通不通更深一层。
    const eg = state?.egress;
    if (eg?.restricted) {
      return row("upstream", "warn",
        `${addr} · 出口${eg.country ?? "?"} — Gemini/Claude/GPT 在该区不可用`, "切上游节点");
    }
    // detail 常自带地址（「127.0.0.1:6478 · 系统代理（HTTP）」），
    // 前缀再拼一遍就重复了 —— 以 detail 开头是地址时直接用 detail。
    const tagged = u.detail?.startsWith(addr) ? u.detail : `${addr}${u.detail ? ` · ${u.detail}` : ""}`;
    return row("upstream", "ok", eg?.country ? `${tagged} · 出口${eg.country}` : tagged);
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
