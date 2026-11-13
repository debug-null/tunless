// 各个面板的渲染组件。每个面板都是一个 React 组件，
// 由 app.js 统一传入状态、终端宽度和滚动位置。

import { Box, Text } from "ink";
import { h, Section, Badge, Card, kv, txt, segments, useTheme, useUnicode } from "./ui.js";
import { padEnd, truncate, wrapText } from "./width.js";
import { symbolSet } from "./theme.js";

export const PANELS = [
  { id: "overview", name: "开始", key: "1" },
  { id: "rules", name: "内网规则", key: "2" },
  { id: "more", name: "更多", key: "3" },
  { id: "help", name: "怎么用", key: "4" },
];

/** 计算表格列宽，保证中文标题和内容对齐 */
function columnsFor(width, ratio) {
  const nameWidth = Math.max(16, Math.min(46, Math.floor((width - 8) * ratio)));
  const ipWidth = Math.max(12, Math.min(22, width - nameWidth - 12));
  return { nameWidth, ipWidth };
}

/**
 * 总览页：四步清单，数字键直达。
 *
 * 之前是「下一步做什么 + 三张状态卡片」，问题是：
 *   · 得先读懂提示才知道该按哪个键
 *   · 状态一变提示就变，键位含义不固定
 *   · 卡片只占 74 列，宽终端下右边空一大片
 *
 * 现在固定四步（选工具 → 用代理启动 → 测连通 → 内网域名），
 * 状态一目了然，卡片铺满终端宽度。
 */
export function OverviewPanel({ state, width, appName = null, reachability = null }) {
  const theme = useTheme();
  const symbols = symbolSet(useUnicode());
  const unicode = useUnicode();
  // 卡片铺满终端宽度：之前固定 74 列，宽终端下右边空一大片。
  const cardWidth = Math.max(56, Math.min(width - 2, 110));
  const stepMarks = unicode ? ["①", "②", "③", "④"] : ["1", "2", "3", "4"];

  const badge = (tone, text) => {
    const symbol = symbols[tone];
    const color = theme.colors[tone] ?? theme.colors.info;
    if (!symbol) return txt(text ?? "", { color, dim: true });
    return txt(text ? `${symbol} ${text}` : symbol, { color });
  };

  // 状态列固定宽度：四行的说明文字才会对齐成一条竖线。
  const STATUS_WIDTH = 12;
  const statusCell = (tone, text) => {
    const symbol = symbols[tone];
    const color = theme.colors[tone] ?? theme.colors.info;
    const label = symbol ? `${symbol} ${text}` : text;
    return txt(padEnd(label, STATUS_WIDTH), { color });
  };

  const side = state.sidecar;
  const core = state.core;

  // ---- 步骤清单 -------------------------------------------------------
  // 每行：序号 · 标题 · 状态 · 说明
  const stepRow = (index, title, statusCellSeg, detail) =>
    [
      txt("  "),
      txt(`${stepMarks[index]} `, { color: theme.colors.accent, bold: true }),
      txt(padEnd(title, 12), { bold: true }),
      statusCellSeg,
      detail ? txt(detail, { dim: true }) : null,
    ].filter(Boolean);

  const steps = [];

  // ① 选工具
  const installed = (state.apps ?? []).filter((a) => a.installed);
  const appDetail = appName
    ? `已选 ${appName}`
    : installed.length
      ? installed
          .map(
            (a) =>
              `${a.name}${a.version ? ` ${a.version}` : ""}${a.running ? "（在跑）" : ""}`,
          )
          .join(" · ")
      : "没检测到支持的工具";
  steps.push(
    stepRow(
      0,
      "选工具",
      statusCell(appName ? "ok" : "warn", appName ? "已选" : "待选择"),
      appDetail,
    ),
  );

  // ② 用代理启动
  const serviceState = statusCell(side.running ? "ok" : "warn", side.running ? "服务在跑" : "服务没跑");
  steps.push(
    stepRow(
      1,
      "用代理启动",
      serviceState,
      side.running
        ? `HTTP ${side.httpPort} · SOCKS5 ${side.socksPort} · 按 2 选应用`
        : "按 2 先启动转发服务",
    ),
  );

  // ③ 测连通性
  const reach = reachability;
  const reachStatus = reach
    ? statusCell(reach.ok ? "ok" : "bad", reach.ok ? "通了" : "不通")
    : statusCell("muted", "没测过");
  steps.push(
    stepRow(2, "测连通性", reachStatus, reach ? reach.detail : "按 3 实测一次外网"),
  );

  // ④ 内网域名
  const domainStatus = state.loading
    ? statusCell("muted", "扫描中")
    : txt(padEnd(`${state.internalDomains.length} 个`, STATUS_WIDTH), {
        bold: true,
        color: state.fakeCount > 0 ? theme.colors.warn : theme.colors.text,
      });
  const needFix = state.fakeCount > 0;
  steps.push(
    stepRow(
      3,
      "内网域名",
      domainStatus,
      state.loading
        ? ""
        : needFix
          ? `${state.fakeCount} 个还拿到假 IP，按 4 修复`
          : "解析正常，按 4 查看",
    ),
  );

  const stepRows = [
    ...steps,
    [txt("  ")],
    [
      txt("  "),
      txt("按 ", { dim: true }),
      txt("1", { color: theme.colors.accent, bold: true }),
      txt(" 选工具 · ", { dim: true }),
      txt("2", { color: theme.colors.accent, bold: true }),
      txt(" 用代理启动 · ", { dim: true }),
      txt("3", { color: theme.colors.accent, bold: true }),
      txt(" 测连通 · ", { dim: true }),
      txt("4", { color: theme.colors.accent, bold: true }),
      txt(" 内网域名 · ", { dim: true }),
      txt("a", { color: theme.colors.accent, bold: true }),
      txt(" 手写域名 · ", { dim: true }),
      txt("q", { color: theme.colors.accent, bold: true }),
      txt(" 退出", { dim: true }),
    ],
  ];

  // ---- 环境：挤成一行，别再撑一张空荡荡的卡片 -----------------------
  const envSegments = [];
  if (core.reachable) {
    envSegments.push(
      txt(`${state.frontend?.label ?? "未知"} ${core.version ?? ""}`.trim()),
      txt(" · 端口 ", { dim: true }),
      txt(String(core.mixedPort ?? "无")),
    );
  } else {
    envSegments.push(badge("bad", "内核连不上"));
  }
  envSegments.push(txt(" · TUN ", { dim: true }));
  envSegments.push(core.tun ? badge("warn", "开着") : badge("ok", "关着"));
  const sys = state.systemProxy;
  envSegments.push(txt(" · 系统代理 ", { dim: true }));
  envSegments.push(
    sys && sys.httpEnabled && sys.httpsEnabled
      ? badge("ok", `${sys.host}:${sys.port}`)
      : badge("warn", "没开"),
  );

  const extraRows = [];
  const manualCount = Object.values(state.rules ?? {}).reduce(
    (sum, list) => sum + (list?.length ?? 0),
    0,
  );
  if (manualCount) {
    extraRows.push(
      kv("手写规则", [txt(`${manualCount} 条`, { bold: true }), txt("  按 4 查看", { dim: true })], 10),
    );
  }

  const noteRows = [];
  for (const note of (state.notes ?? []).slice(0, 1)) {
    for (const [i, text] of wrapText(note.replace(/\n/g, " "), cardWidth - 10).entries()) {
      noteRows.push(
        i === 0
          ? [txt("  "), badge("warn", text)]
          : [txt("    "), txt(text, { dim: true })],
      );
    }
  }

  return h(
    Box,
    { flexDirection: "column" },
    // 一句话说清这工具是干什么的，省得用户对着界面猜。
    h(
      Text,
      { dimColor: true },
      "  给连不上外网的 agent 一个本地代理口（127.0.0.1:8899），不用开 TUN。",
    ),
    h(Text, null, " "),
    h(Card, { title: "四步搞定", width: cardWidth, rows: stepRows }),
    h(Text, null, " "),
    h(Text, null, ...segments([txt("  环境 ", { dim: true }), ...envSegments], "env")),
    ...extraRows,
    noteRows.length ? h(Card, { title: "提示", width: cardWidth, rows: noteRows }) : null,
  );
}
