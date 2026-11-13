// 最近事件流：从 app.js 的 log() 事件环渲染最近 N 条，按 kind 着色。
import { Box, Text } from "ink";
import { h, useTheme } from "../ui.js";

export function EventFeed({ events = [], limit = 3 }) {
  const theme = useTheme();
  const KIND = { ok: theme.colors.ok, warn: theme.colors.warn, bad: theme.colors.bad };
  const tail = events.slice(-limit);
  return h(
    Box,
    { flexDirection: "column" },
    tail.map((e, i) =>
      h(
        Text,
        { key: `${e.time}-${i}` },
        h(Text, { dimColor: true }, `  ${e.time} `),
        h(Text, { color: KIND[e.kind] ?? theme.colors.text, dimColor: e.kind === "info" }, e.text),
      )),
  );
}
