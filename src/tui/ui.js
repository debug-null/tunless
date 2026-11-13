// 通用 UI 组件：主题上下文、卡片、标签栏、键值行、状态徽标、表格。
//
// 全部使用 React.createElement（项目不引入编译步骤，源码即运行）。
// 中文列对齐不能依赖字符数量，因此表格的列宽计算走 width.js 的显示宽度。
//
// 组件划分参照 lore 的 termcn（Card / Badge / Table / Tabs / KeyValue），
// 但用 ink 原生属性实现，不引入额外依赖。

import React, { createContext, useContext } from "react";
import { Box, Text } from "ink";
import { displayWidth, padEnd, padStart, truncate } from "./width.js";
import { DARK_THEME, borderSet, symbolSet } from "./theme.js";

export const h = React.createElement;

const ThemeContext = createContext({ theme: DARK_THEME, unicode: true });

export function ThemeProvider({ theme, unicode = true, children }) {
  const value = { theme: theme ?? DARK_THEME, unicode };
  return h(ThemeContext.Provider, { value }, children);
}

export function useTheme() {
  return useContext(ThemeContext).theme;
}

export function useUnicode() {
  return useContext(ThemeContext).unicode;
}

/**
 * 卡片：带边框的内容块。
 *
 * 边框自己画，不用 ink 的 borderStyle —— ink v8 在「固定宽度 + 行布局」下
 * 边框宽度会随内容变化，对齐不了。这里按显示宽度逐行拼，
 * 中文与英文混排也能严格对齐。
 */

/** 文本片段 */
export function txt(text, opts = {}) {
  return { text: String(text), ...opts };
}

/** 把一组文本片段渲染成 React 元素（不能直接把片段丢给 <Text>） */
export function segments(parts, keyPrefix = "s") {
  return parts
    .filter(Boolean)
    .map((seg, i) =>
      h(
        Text,
        {
          key: `${keyPrefix}-${i}`,
          color: seg.color,
          dimColor: seg.dim,
          bold: seg.bold,
        },
        seg.text,
      ),
    );
}

/** 键值行片段：标签按显示宽度补齐 */
export function kv(label, valueSegments, labelWidth = 12) {
  return [
    txt("  ", { dim: true }),
    txt(padEnd(label, labelWidth), { dim: true }),
    ...valueSegments,
  ];
}

export function Card({ title, width = 60, rows = [] }) {
  const theme = useTheme();
  const inner = Math.max(12, width - 4);
  const border = theme.colors.border;
  const glyphs = borderSet(useUnicode());

  /**
   * 一行内容放不下时折行，而不是把字砍掉。
   * 之前是直接 truncate，用户看到的是「带代理…」这种断句，读不出意思。
   * 折行时后续行按同样的缩进对齐，视觉上仍是一段话。
   */
  const layout = (segments) => {
    const lines = [[]];
    let used = 0;

    for (const seg of segments) {
      const text = String(seg.text ?? "");
      const w = displayWidth(text);
      if (used + w <= inner) {
        lines[lines.length - 1].push(seg);
        used += w;
        continue;
      }

      // 这个片段自己就超宽：按可用宽度切成多段
      let remaining = text;
      let avail = inner - used;
      while (displayWidth(remaining) > avail) {
        const cut = truncate(remaining, avail);
        if (!cut) break;
        lines[lines.length - 1].push({ ...seg, text: cut });
        remaining = remaining.slice(cut.length - 1); // 去掉末尾的 …
        lines.push([]);
        used = 0;
        avail = inner;
      }
      if (remaining) {
        lines[lines.length - 1].push({ ...seg, text: remaining });
        used = displayWidth(remaining);
      }
    }
    return lines;
  };

  const line = (segments, indent = 0) => {
    const fitted = segments;
    const used = fitted.reduce((sum, seg) => sum + displayWidth(seg.text), 0);
    const pad = Math.max(0, inner - used);
    return h(
      Text,
      null,
      h(Text, { color: border }, glyphs.vertical),
      " ",
      " ".repeat(indent),
      ...fitted.map((seg, i) =>
        h(
          Text,
          {
            key: i,
            color: seg.color,
            dimColor: seg.dim,
            bold: seg.bold,
          },
          seg.text,
        ),
      ),
      " ".repeat(pad),
      " ",
      h(Text, { color: border }, glyphs.vertical),
    );
  };

  const top = h(
    Text,
    { color: border },
    `${glyphs.topLeft}${glyphs.horizontal.repeat(width - 2)}${glyphs.topRight}`,
  );
  const bottom = h(
    Text,
    { color: border },
    `${glyphs.bottomLeft}${glyphs.horizontal.repeat(width - 2)}${glyphs.bottomRight}`,
  );
  const titleRow = title
    ? line([txt(title, { color: theme.colors.text, bold: true })])
    : null;

  // 每行内容折行后的所有物理行
  const bodyRows = [];
  for (const row of rows) {
    const segments = Array.isArray(row) ? row : [txt(String(row))];
    const lines = layout(segments);
    for (let i = 0; i < lines.length; i += 1) {
      // 续行跟首行内容对齐（首行前面通常有缩进），这里用 2 列
      bodyRows.push(line(lines[i], i === 0 ? 0 : 2));
    }
  }

  return h(
    Box,
    { flexDirection: "column" },
    top,
    titleRow,
    ...bodyRows,
    bottom,
  );
}

/** 标签栏：显示当前选中的面板 */
export function Tabs({ items, activeId }) {
  const theme = useTheme();
  return h(
    Box,
    { flexDirection: "row", gap: 1 },
    items.map((item) =>
      h(
        Text,
        {
          key: item.id,
          color: item.id === activeId ? theme.colors.accent : theme.colors.muted,
          bold: item.id === activeId,
          inverse: item.id === activeId,
        },
        ` ${item.key} ${item.name} `,
      ),
    ),
  );
}

/** 小节标题 */
export function Section({ title, children }) {
  const theme = useTheme();
  return h(
    Box,
    { flexDirection: "column", marginTop: 1 },
    h(Text, { color: theme.colors.accent, bold: true }, ` ${title} `),
    h(Box, { flexDirection: "column" }, children),
  );
}

/** 状态徽标：✔ 正常 / ▲ 警告 / ✖ 问题 / • 信息 */
export function Badge({ tone = "info", children }) {
  const theme = useTheme();
  const symbols = symbolSet(useUnicode());
  // muted 这类状态不带符号，只显示文字
  const symbol = symbols[tone];
  const color = theme.colors[tone] ?? theme.colors.info;
  if (!symbol) return h(Text, { color, dimColor: tone === "muted" }, children ?? "");
  return h(Text, { color }, children ? `${symbol} ${children}` : symbol);
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
