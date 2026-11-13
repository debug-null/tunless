// 向导步骤外框：标题写清楚「第几步 / 共几步」。
//
// 从 steps.js 抽出来：钻取屏（上游屏的 embedded 模式）要复用同一个框，
// 独立成文件后 steps.js 与 screens/* 都引用它，模块图上没有环。
import { Box, Text } from "ink";
import { h, Card } from "./ui.js";

export function StepFrame({ step, total, title, width, rows, footer }) {
  const cardWidth = Math.max(56, Math.min(width - 2, 110));
  return h(
    Box,
    { flexDirection: "column" },
    h(Text, { dimColor: true }, `  第 ${step} 步 / 共 ${total} 步`),
    h(Text, null, " "),
    h(Card, { title, width: cardWidth, rows }),
    footer ? h(Text, null, " ") : null,
    footer ? h(Text, { dimColor: true }, `  ${footer}`) : null,
  );
}
