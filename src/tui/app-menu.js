// 按 l 弹出的「选哪个应用」菜单。
//
// 之前是「按一次换一个」地轮流启动，用户根本不知道当前轮到谁。
// 改成显式选择：上下移动、回车确认、Esc 取消。

import { Box, Text } from "ink";
import { h, Card, txt, useTheme } from "./ui.js";
import { APPS } from "../core/apps.js";

export function AppMenu({ width, index = 0 }) {
  const theme = useTheme();
  const cardWidth = Math.min(width, 72);

  const rows = APPS.map((app, i) => {
    const selected = i === index;
    return [
      txt("  ", { dim: true }),
      txt(selected ? "› " : "  ", { color: selected ? theme.colors.accent : undefined }),
      txt(app.name, { bold: selected, color: selected ? theme.colors.accent : undefined }),
      txt("    "),
      txt(app.description, { dim: true }),
    ];
  });

  rows.push(
    [txt("  "), txt("  "), txt("  "), txt("")],
    [
      txt("  "),
      txt("  "),
      txt("  "),
      txt("回车启动 · ↑↓ 选择 · Esc 取消", { dim: true }),
    ],
  );

  return h(
    Box,
    { flexDirection: "column" },
    h(Card, { title: "要带代理启动哪个应用？", width: cardWidth, rows }),
  );
}
