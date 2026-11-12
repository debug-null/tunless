// 各个面板的渲染组件。每个面板都是一个 React 组件，
// 由 app.js 统一传入状态、终端宽度和滚动位置。

import { Box, Text } from "ink";
import { h, Section, Badge, Card, kv, txt, useTheme, useUnicode } from "./ui.js";
import { padEnd, truncate, wrapText } from "./width.js";
import { symbolSet } from "./theme.js";

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
  const theme = useTheme();
  const symbols = symbolSet(useUnicode());

  /** 状态徽标片段 */
  const badge = (tone, text) => {
    const symbol = symbols[tone];
    const color = theme.colors[tone] ?? theme.colors.info;
    if (!symbol) return txt(text ?? "", { color, dim: true });
    return txt(text ? `${symbol} ${text}` : symbol, { color });
  };

  const coreRows = [];
  if (state.core.reachable) {
    coreRows.push(
      kv("客户端", [txt(state.frontend?.label ?? "未知")]),
      kv("内核版本", [txt(`${state.core.version ?? "未知"}  ${state.core.mode ?? "-"} 模式`)]),
      kv("混合端口", [
        state.core.mixedPort
          ? txt(String(state.core.mixedPort))
          : txt("未开放", { color: theme.colors.muted }),
      ]),
      kv("TUN 模式", [
        badge(state.core.tun ? "ok" : "warn", state.core.tun ? "已开启" : "已关闭"),
      ]),
    );
    if (!state.core.tun) {
      coreRows.push([txt("  只有完全忽略代理的程序才需要它", { dim: true })]);
    }
  } else {
    coreRows.push(kv("状态", [badge("bad", "内核不可达")]));
    for (const e of state.errors.slice(0, 3)) {
      coreRows.push(kv("", [txt(e, { color: theme.colors.bad })]));
    }
  }

  if (state.systemProxy) {
    const sys = state.systemProxy;
    coreRows.push(
      kv("系统代理", [
        sys.httpEnabled && sys.httpsEnabled
          ? badge("ok", `已启用 ${sys.host}:${sys.port}`)
          : badge("warn", "未启用"),
      ]),
    );
  }

  const side = state.sidecar;
  const sideRows = [
    kv("转发服务", [
      side.running ? badge("ok", `运行中 (pid ${side.pid})`) : badge("warn", "未运行"),
    ]),
    kv("  HTTP", [
      side.httpOpen
        ? badge("ok", `127.0.0.1:${side.httpPort}`)
        : badge("muted", "未监听"),
    ]),
    kv("  SOCKS5", [
      side.socksOpen
        ? badge("ok", `127.0.0.1:${side.socksPort}`)
        : badge("muted", "未监听"),
    ]),
  ];

  const loading = state.loading;
  const summaryRows = [
    kv("内网域名", [
      loading
        ? txt("扫描中…", { dim: true })
        : txt(String(state.internalDomains.length), { bold: true }),
      loading ? null : txt(" 个解析到私网地址"),
    ].filter(Boolean)),
    kv("公网域名", [txt(loading ? "—" : `${state.publicCount} 个`)]),
    kv("仍为假 IP", [txt(loading ? "—" : `${state.fakeCount} 个`)]),
    kv("无法解析", [txt(loading ? "—" : `${state.unresolvedCount} 个`)]),
    kv(
      "归并后缀",
      loading
        ? [txt("—")]
        : state.suffixes.length
          ? state.suffixes.flatMap((suffix, i) => [
              i > 0 ? txt("、", { dim: true }) : null,
              txt(suffix, { color: theme.colors.info }),
            ]).filter(Boolean)
          : [txt("无")],
    ),
  ];

  const cardWidth = Math.min(width, 74);

  // 提示可能很长，在卡片里按显示宽度换行，不截断
  const noteRows = state.notes?.length
    ? state.notes.slice(0, 3).flatMap((note) => {
        const lines = wrapText(note.replace(/\n/g, " "), cardWidth - 6);
        return lines.map((text, i) =>
          i === 0 ? [txt("  "), badge("warn", text)] : [txt("    " + text)],
        );
      })
    : null;

  // 宽终端下把「代理内核」和「转发服务」并排放，避免右边空一大片
  const twoColumn = width >= 96;

  // 并排的两张卡片高度要一致，否则右边的框会在半空中收尾
  const height = Math.max(coreRows.length, sideRows.length);
  const pad = (rows) => [...rows, ...Array.from({ length: height - rows.length }, () => [])];
  const coreCardRows = pad(coreRows);
  const sideCardRows = pad(sideRows);

  return h(
    Box,
    { flexDirection: "column" },
    twoColumn
      ? h(
          Box,
          { flexDirection: "row", gap: 1 },
          h(Card, { title: "代理内核", width: 48, rows: coreCardRows }),
          h(Card, { title: "转发服务", width: 40, rows: sideCardRows }),
        )
      : h(
          Box,
          { flexDirection: "column" },
          h(Card, { title: "代理内核", width: cardWidth, rows: coreRows }),
          h(Card, { title: "转发服务", width: cardWidth, rows: sideRows }),
        ),
    h(Card, { title: "内网概况", width: cardWidth, rows: summaryRows }),
    noteRows ? h(Card, { title: "提示", width: cardWidth, rows: noteRows }) : null,
  );
}

export function DomainsPanel({ state, width, scroll, height, query }) {
  const theme = useTheme();

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
      h(
        Text,
        { dimColor: true },
        query ? `  没有匹配「${query}」的域名` : "  未发现解析到私网地址的域名",
      ),
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
      "  ",
      h(Text, { color: theme.colors.text }, padEnd(truncate(d.name, nameWidth), nameWidth)),
      h(Text, { color: theme.colors.info }, padEnd(truncate(d.ips.join(", "), ipWidth), ipWidth)),
      h(Badge, { tone: "ok" }, "私网"),
    ),
  );

  return h(
    Box,
    { flexDirection: "column" },
    header,
    ...body,
    rows.length > slice.length || start > 0
      ? h(Text, { dimColor: true }, `  显示 ${start + 1}-${start + slice.length} / ${rows.length}`)
      : null,
  );
}

export function ProcessesPanel({ state, scroll, height }) {
  const theme = useTheme();

  if (!state.processes.length) {
    return h(Box, { flexDirection: "column" }, h(Text, { dimColor: true }, "  未发现相关进程"));
  }

  const nameWidth = 52;
  const header = h(Text, { dimColor: true }, `  ${padEnd("程序", nameWidth)}代理能力`);

  const visible = Math.max(1, height - 3);
  const start = Math.min(scroll, Math.max(0, state.processes.length - visible));
  const slice = state.processes.slice(start, start + visible);

  const body = slice.map((p) => {
    const tone = p.status === "supported" ? "ok" : p.status === "unsupported" ? "warn" : "muted";
    const label = p.status === "supported" ? "支持" : p.status === "unsupported" ? "不支持" : "未知";
    return h(
      Text,
      { key: `${p.pid}-${p.comm}` },
      "  ",
      h(Text, { color: theme.colors.text }, padEnd(truncate(p.comm, nameWidth - 1), nameWidth)),
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
  const theme = useTheme();

  const suffixRows = state.loading
    ? [h(Text, { key: "l", dimColor: true }, "    扫描中…")]
    : state.suffixes.length
      ? state.suffixes.map((s) =>
          h(Text, { key: s }, "    ", h(Text, { color: theme.colors.info }, "+." + s)),
        )
      : [h(Text, { key: "n", dimColor: true }, "    无")];

  return h(
    Box,
    { flexDirection: "column" },
    h(Text, { dimColor: true }, "  netfix proxy 依据此表决定目标走直连还是走内核"),
    "",
    h(
      Text,
      null,
      "  ",
      h(Text, { bold: true }, "内网后缀"),
      "  ",
      h(Text, { dimColor: true }, "(直连，不经过代理)"),
    ),
    ...suffixRows,
    "",
    h(
      Text,
      null,
      "  ",
      h(Text, { bold: true }, "其他域名"),
      "  ",
      h(Text, { dimColor: true }, "(转交内核 7897 端口)"),
    ),
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
          h(Badge, { tone: e.kind === "muted" ? "info" : e.kind }),
          " ",
          e.text,
        ),
      ),
  );
}
