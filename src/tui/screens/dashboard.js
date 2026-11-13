// 仪表盘（家）：四行子系统判词 + 总判决 + 最近事件。
// 行的判词来自 src/core/status-rows.js —— CLI doctor 看到的是同一套说法。
import { Box, Text } from "ink";
import { h, useTheme } from "../ui.js";
import { rowsFor, verdictFor } from "../../core/status-rows.js";
import { StatusRow } from "../components/status-row.js";
import { EventFeed } from "../components/event-feed.js";

const TONE = (theme) => ({ ok: theme.colors.ok, warn: theme.colors.warn, bad: theme.colors.bad, info: theme.colors.info });

export function Dashboard({ state, rowIndex = 0, width = 80, events = [] }) {
  const theme = useTheme();
  const rows = rowsFor(state);
  const verdict = verdictFor(state);
  const tone = TONE(theme)[verdict.tone] ?? theme.colors.info;
  return h(
    Box,
    { flexDirection: "column" },
    h(Text, { color: tone, bold: true }, ` ● ${verdict.text}`),
    h(Text, null, " "),
    ...rows.map((row, i) =>
      h(StatusRow, { key: row.id, row, selected: i === rowIndex, width })),
    h(Text, null, " "),
    h(EventFeed, { events, limit: 3 }),
  );
}
