// 通用 UI 组件：标题块、键值行、状态徽标、表格。
//
// 全部使用 React.createElement（项目不引入编译步骤，源码即运行）。
// 中文列对齐不能依赖字符数量，因此表格的列宽计算走 width.js 的显示宽度。

import React from "react";
import { Box, Text } from "ink";
import { displayWidth, padEnd, padStart, truncate } from "./width.js";
import { TONE, BADGE_SYMBOL } from "./theme.js";

export const h = React.createElement;

/** 小节标题 */
export function Section({ title, children }) {
  return h(
    Box,
    { flexDirection: "column", marginTop: 1 },
    h(Text, { color: TONE.accent, bold: true }, ` ${title} `),
    h(Box, { flexDirection: "column" }, children),
  );
}

/** 状态徽标：✔ 正常 / ▲ 警告 / ✖ 问题 / • 信息 */
export function Badge({ tone = "info", children }) {
  const symbol = BADGE_SYMBOL[tone] ?? BADGE_SYMBOL.info;
  return h(
    Text,
    { color: TONE[tone] ?? TONE.info },
    children ? `${symbol} ${children}` : symbol,
  );
}

/** 键值行，值可以是字符串，也可以是带样式的元素 */
export function KV({ label, value, tone, labelWidth = 12 }) {
  const head = h(Text, { dimColor: true }, `  ${padEnd(label, labelWidth)}`);
  let body;
  if (value && typeof value === "object") {
    body = value;
  } else if (tone) {
    body = h(Text, { color: TONE[tone] }, String(value ?? ""));
  } else {
    body = String(value ?? "");
  }
  return h(Text, null, head, body);
}

/** 表格：columns 描述列，rows 是每行的字符串数组 */
export function Table({ columns, rows, empty }) {
  if (!rows.length) {
    return h(Text, { dimColor: true }, `  ${empty ?? "无数据"}`);
  }
  const header = h(
    Text,
    { dimColor: true },
    `  ${columns.map((col) => padEnd(col.title, col.width)).join("")}`,
  );
  const body = rows.map((cells) =>
    h(
      Text,
      null,
      `  ${cells
        .map((cell, i) => {
          const col = columns[i];
          const text = truncate(String(cell ?? ""), col.width);
          return col.align === "right" ? padStart(text, col.width) : padEnd(text, col.width);
        })
        .join("")}`,
    ),
  );
  return h(Box, { flexDirection: "column" }, header, ...body);
}

export { displayWidth };
