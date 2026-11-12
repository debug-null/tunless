// 各个面板的渲染组件。每个面板都是一个 React 组件，
// 由 app.js 统一传入状态、终端宽度和滚动位置。

import { Box, Text } from "ink";
import { h, Section, KV, Badge } from "./ui.js";
import { TONE, SYMBOLS } from "./theme.js";
import { padEnd, truncate } from "./width.js";

export const PANELS = [
  { id: "overview", name: "总览", key: "1" },
  { id: "domains", name: "内网域名", key: "2" },
  { id: "processes", name: "程序代理能力", key: "3" },
  { id: "routes", name: "分流规则", key: "4" },
  { id: "events", name: "操作日志", key: "5" },
];

/** 计算表格列宽，保证中文标题和内容对齐 */
function columnsFor(width, ratio) {
  const nameWidth = Math.max(16, Math.min(46, Math.floor((width - 8) * ratio)));
  const ipWidth = Math.max(12, Math.min(22, width - nameWidth - 12));
  return { nameWidth, ipWidth };
}

export function OverviewPanel({ state, width }) {
  const core = state.core;
  const side = state.sidecar;
  const sys = state.systemProxy;

  const coreRows = [];
  if (core.reachable) {
    coreRows.push(
      h(KV, { key: "a", label: "客户端", value: state.frontend?.label ?? "未知" }),
      h(KV, {
        key: "b",
        label: "内核版本",
        value: `${core.version ?? "未知"}  ${core.mode ?? "-"} 模式`,
      }),
      h(KV, {
        key: "c",
        label: "混合端口",
        value: core.mixedPort ? String(core.mixedPort) : "未开放",
        tone: core.mixedPort ? undefined : TONE.muted,
      }),
      h(KV, {
        key: "d",
        label: "TUN 模式",
        value: core.tun
          ? h(Badge, { tone: "ok" }, "已开启")
          : h(Text, null, h(Badge, { tone: "warn" }, "已关闭"), " 只有完全忽略代理的程序才需要它"),
      }),
    );
  } else {
    coreRows.push(h(KV, { key: "a", label: "状态", value: h(Badge, { tone: "bad" }, "内核不可达") }));
    for (const [i, e] of state.errors.slice(0, 3).entries()) {
      coreRows.push(h(KV, { key: `e${i}`, label: "", value: e, tone: TONE.bad }));
    }
  }

  if (sys) {
    coreRows.push(
      h(KV, {
        key: "s",
        label: "系统代理",
        value:
          sys.httpEnabled && sys.httpsEnabled
            ? h(Badge, { tone: "ok" }, `已启用 ${sys.host}:${sys.port}`)
            : h(Badge, { tone: "warn" }, "未启用"),
      }),
    );
  }

  const sideRows = [
    h(KV, {
      key: "r",
      label: "转发服务",
      value: side.running
        ? h(Badge, { tone: "ok" }, `运行中 (pid ${side.pid})`)
        : h(Badge, { tone: "warn" }, "未运行"),
    }),
    h(KV, {
      key: "h",
      label: "  HTTP",
      value: side.httpOpen
        ? h(Badge, { tone: "ok" }, `127.0.0.1:${side.httpPort}`)
        : h(Badge, { tone: "muted" }, "未监听"),
    }),
    h(KV, {
      key: "o",
      label: "  SOCKS5",
      value: side.socksOpen
        ? h(Badge, { tone: "ok" }, `127.0.0.1:${side.socksPort}`)
        : h(Badge, { tone: "muted" }, "未监听"),
    }),
  ];

  const loading = state.loading;
  const summaryRows = [
    h(KV, {
      key: "i",
      label: "内网域名",
      value: loading
        ? "扫描中…"
        : h(Text, null, h(Text, { bold: true }, String(state.internalDomains.length)), " 个解析到私网地址"),
    }),
    h(KV, { key: "p", label: "公网域名", value: loading ? "—" : `${state.publicCount} 个` }),
    h(KV, { key: "f", label: "仍为假 IP", value: loading ? "—" : `${state.fakeCount} 个` }),
    h(KV, { key: "u", label: "无法解析", value: loading ? "—" : `${state.unresolvedCount} 个` }),
    h(KV, {
      key: "s",
      label: "归并后缀",
      value: loading
        ? "—"
        : state.suffixes.length
          ? state.suffixes.flatMap((s, i) => [
              i > 0 ? h(Text, { key: `sep${s}`, dimColor: true }, "、") : null,
              h(Text, { key: s, color: TONE.info }, s),
            ])
          : "无",
    }),
  ];

  return h(
    Box,
    { flexDirection: "column" },
    h(Section, { title: "代理内核" }, coreRows),
    h(Section, { title: "转发服务" }, sideRows),
    h(Section, { title: "内网概况" }, summaryRows),
    state.notes?.length
      ? h(
          Section,
          { title: "提示" },
          state.notes.slice(0, 3).map((n, i) =>
            h(Text, { key: i }, `  `, h(Badge, { tone: "warn" }, n)),
          ),
        )
      : null,
  );
}

export function DomainsPanel({ state, width, scroll, height, query }) {
  if (state.loading) {
    return h(Box, { flexDirection: "column" }, h(Text, { dimColor: true }, "  正在扫描并解析…"));
  }

  const all = state.internalDomains;
  const rows = query
    ? all.filter((d) => d.name.toLowerCase().includes(query.toLowerCase()))
    : all;

  if (!rows.length) {
    return h(
      Box,
      { flexDirection: "column" },
      h(Text, { dimColor: true }, query ? `  没有匹配「${query}」的域名` : "  未发现解析到私网地址的域名"),
    );
  }

  const { nameWidth, ipWidth } = columnsFor(width, 0.5);
  const header = h(
    Text,
    { dimColor: true },
    `  ${padEnd("域名", nameWidth)}${padEnd("解析地址", ipWidth)}判定`,
  );

  const visible = Math.max(1, height - 2);
  const start = Math.min(scroll, Math.max(0, rows.length - visible));
  const slice = rows.slice(start, start + visible);

  const body = slice.map((d) =>
    h(
      Text,
      { key: d.name },
      `  `,
      h(Text, { color: TONE.text }, padEnd(truncate(d.name, nameWidth), nameWidth)),
      h(Text, { color: TONE.info }, padEnd(truncate(d.ips.join(", "), ipWidth), ipWidth)),
      h(Badge, { tone: "ok" }, "私网"),
    ),
  );

  return h(
    Box,
    { flexDirection: "column" },
    header,
    ...body,
    rows.length > slice.length || start > 0
      ? h(
          Text,
          { dimColor: true },
          `  显示 ${start + 1}-${start + slice.length} / ${rows.length}`,
        )
      : null,
  );
}

export function ProcessesPanel({ state, scroll, height }) {
  if (!state.processes.length) {
    return h(Box, { flexDirection: "column" }, h(Text, { dimColor: true }, "  未发现相关进程"));
  }

  const nameWidth = 52;
  const header = h(
    Text,
    { dimColor: true },
    `  ${padEnd("程序", nameWidth)}代理能力`,
  );

  const visible = Math.max(1, height - 3);
  const start = Math.min(scroll, Math.max(0, state.processes.length - visible));
  const slice = state.processes.slice(start, start + visible);

  const body = slice.map((p) => {
    const tone = p.status === "supported" ? "ok" : p.status === "unsupported" ? "warn" : "muted";
    const label = p.status === "supported" ? "支持" : p.status === "unsupported" ? "不支持" : "未知";
    return h(
      Text,
      { key: `${p.pid}-${p.comm}` },
      `  `,
      h(Text, { color: TONE.text }, padEnd(truncate(p.comm, nameWidth - 1), nameWidth)),
      h(Badge, { tone }, label),
    );
  });

  return h(
    Box,
    { flexDirection: "column" },
    h(
      Text,
      { dimColor: true },
      "  检测运行中的程序是否支持 HTTPS_PROXY 环境变量（Go 的 httpproxy 符号）",
    ),
    "",
    header,
    ...body,
    state.processes.length > slice.length || start > 0
      ? h(
          Text,
          { dimColor: true },
          `  显示 ${start + 1}-${start + slice.length} / ${state.processes.length}`,
        )
      : null,
  );
}

export function RoutesPanel({ state }) {
  const suffixRows = state.loading
    ? [h(Text, { key: "l", dimColor: true }, "    扫描中…")]
    : state.suffixes.length
      ? state.suffixes.map((s) =>
          h(Text, { key: s }, "    ", h(Text, { color: TONE.info }, "+." + s)),
        )
      : [h(Text, { key: "n", dimColor: true }, "    无")];

  return h(
    Box,
    { flexDirection: "column" },
    h(Text, { dimColor: true }, "  netfix proxy 依据此表决定目标走直连还是走内核"),
    "",
    h(Text, null, "  ", h(Text, { bold: true }, "内网后缀"), "  ", h(Text, { dimColor: true }, "(直连，不经过代理)")),
    ...suffixRows,
    "",
    h(Text, null, "  ", h(Text, { bold: true }, "其他域名"), "  ", h(Text, { dimColor: true }, "(转交内核 7897 端口)")),
    h(Text, { dimColor: true }, "    *"),
    h(Section, { title: "提示" }, [
      h(Text, { key: "t", dimColor: true }, "  内网域名不会进入代理，因此不会拿到假 IP 地址。"),
    ]),
  );
}

export function EventsPanel({ events }) {
  if (!events.length) {
    return h(Box, { flexDirection: "column" }, h(Text, { dimColor: true }, "  暂无操作记录"));
  }
  const tone = { ok: "ok", warn: "warn", bad: "bad", info: "info" };
  return h(
    Box,
    { flexDirection: "column" },
    ...events
      .slice(-40)
      .reverse()
      .map((e, i) =>
        h(
          Text,
          { key: `${e.time}-${i}` },
          "  ",
          h(Text, { dimColor: true }, e.time),
          " ",
          h(Badge, { tone: tone[e.kind] ?? "info" }),
          " ",
          e.text,
        ),
      ),
  );
}

export { SYMBOLS };
