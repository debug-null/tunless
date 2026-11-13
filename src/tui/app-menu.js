// 按 l 弹出的菜单。
//
// 两级选择：
//   第一级：选哪个应用
//   第二级：选怎么处理（只注入环境变量 / 同时写配置文件 / 只写配置不启动）
//
// 之前是「按一次换一个」地轮流启动，用户既不知道当前轮到谁，
// 也不知道工具会替自己改哪些文件。现在两件事都由用户明确选择。

import { Box, Text } from "ink";
import { h, Card, txt, useTheme } from "./ui.js";
import { padEnd } from "./width.js";
import { APPS, findApp } from "../core/apps.js";

/** 每个应用可选的处理方式 */
export const ACTIONS = [
  {
    id: "env",
    label: "只注入代理环境变量后启动",
    detail: "不改任何配置文件，随时可以撤销",
    // 有些应用只认环境变量（Antigravity 的模型服务就是），
    // 有些只认配置文件里的代理（Cursor 的 Agent 就是）。
    // envOnlyEnough=false 的应用，选这个会连不上模型。
    envOnlyEnough: true,
  },
  {
    id: "env+settings",
    label: "注入环境变量 + 写入代理配置后启动",
    detail: "会改 settings.json（自动备份），让应用自身的网络请求也走代理",
    envOnlyEnough: true,
  },
  {
    id: "settings",
    label: "只写入代理配置，不启动",
    detail: "你自己决定什么时候重启应用",
    envOnlyEnough: true,
  },
];

/**
 * 某个应用该显示哪些处理方式。
 *
 * Cursor 的 Agent 不读环境变量代理，只注入环境变量是连不上模型的，
 * 这一项对它没有意义，就不列出来 —— 与其标成「不推荐」让人纠结，
 * 不如根本不让它出现在选择里。
 */
export function actionsFor(appId) {
  const app = findApp(appId);
  if (app && app.envOnlyEnough === false) {
    return ACTIONS.filter((action) => action.id !== "env");
  }
  return ACTIONS;
}

export function AppMenu({ width, index = 0, stage = "app", app = null, actionIndex = 0 }) {
  const theme = useTheme();
  // 菜单铺满终端宽度，和总览页保持一致的观感
  const cardWidth = Math.max(56, Math.min(width - 2, 110));

  const row = (selected, title, detail, titleWidth) => [
    txt("  ", { dim: true }),
    txt(selected ? "› " : "  ", { color: selected ? theme.colors.accent : undefined }),
    txt(padEnd(title, titleWidth), {
      bold: selected,
      color: selected ? theme.colors.accent : undefined,
    }),
    txt("   "),
    txt(detail, { dim: true }),
  ];

  let rows;
  let title;

  if (stage === "app") {
    title = "要带代理启动哪个应用？";
    rows = APPS.map((a, i) => row(i === index, a.name, a.description, 16));
  } else {
    title = `${app?.name ?? ""} 要怎么处理？`;
    rows = ACTIONS.map((a, i) => row(i === actionIndex, a.label, a.detail, 34));
  }

  rows.push(
    [txt("  "), txt("  "), txt("  "), txt("")],
    [
      txt("  "),
      txt("  "),
      txt("  "),
      txt(stage === "app" ? "回车继续 · ↑↓ 选择 · Esc 取消" : "回车确认 · ↑↓ 选择 · Esc 返回", {
        dim: true,
      }),
    ],
  );

  return h(
    Box,
    { flexDirection: "column" },
    h(Card, { title, width: cardWidth, rows }),
  );
}
