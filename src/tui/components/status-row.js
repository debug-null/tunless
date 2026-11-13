// 仪表盘行：判词（icon+色） + 标签 + 详情 + 行尾动作提示。
// 数据来自 src/core/status-rows.js 的 rowsFor —— 本组件只管渲染。
import { Box, Text } from "ink";
import { h, useTheme, useUnicode, txt, segments } from "../ui.js";
import { symbolSet } from "../theme.js";
import { truncate, padEnd } from "../width.js";

const ICON = (symbols) => ({
  ok: symbols.ok, warn: symbols.warn, bad: symbols.bad, unknown: "?", info: symbols.info,
});

export function StatusRow({ row, selected = false, width = 80 }) {
  const theme = useTheme();
  const symbols = symbolSet(useUnicode());
  const color = { ok: theme.colors.ok, warn: theme.colors.warn, bad: theme.colors.bad, unknown: theme.colors.muted }[row.status] ?? theme.colors.text;
  const budget = Math.max(20, width - 24);
  const detail = truncate(row.detail ?? "", budget);
  const parts = [
    txt(selected ? ` ${symbols.arrow} ` : "   ", { color: selected ? theme.colors.accent : undefined, bold: selected }),
    txt(`${ICON(symbols)[row.status] ?? "?"} `, { color }),
    txt(padEnd(row.label, 5), { bold: true }),
    txt(detail, { color: row.status === "unknown" ? theme.colors.muted : undefined, dim: row.status === "unknown" }),
    row.action ? txt(`  ${symbols.dot} ${row.action}`, { color: theme.colors.accent }) : null,
  ].filter(Boolean);
  return h(Box, null, h(Text, null, ...segments(parts)));
}
