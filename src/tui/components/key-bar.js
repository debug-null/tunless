// 底部按键提示条：当前屏幕可用的键，上下文感知。
import { Box, Text } from "ink";
import { h, useTheme, txt, segments } from "../ui.js";

export function KeyBar({ keys = [] }) {
  const theme = useTheme();
  const parts = keys.flatMap(([key, label], i) => [
    i ? txt("  ") : null,
    txt(` ${key} `, { color: theme.colors.accent, bold: true }),
    txt(label, { dim: true }),
  ]).filter(Boolean);
  return h(Box, null, h(Text, null, ...segments(parts)));
}
