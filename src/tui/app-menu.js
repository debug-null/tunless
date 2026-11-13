// 应用处理方式模型。
//
// 两级选择（选应用 → 选怎么处理）由 screens/apps.js 渲染；
// 这里只留「每个应用有哪些处理方式」的判定，向导与工具屏共用。
//
// 之前是「按一次换一个」地轮流启动，用户既不知道当前轮到谁，
// 也不知道工具会替自己改哪些文件。现在两件事都由用户明确选择。

import { findApp } from "../core/apps.js";

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

  // Codex 有两副面孔：终端命令和桌面客户端（ChatGPT.app），
  // 但共用同一个 ~/.codex/.env。它没有 settings.json，
  // 也不存在「带环境变量启动它」这回事（客户端是 GUI）。
  if (app?.id === "codex") {
    return [
      {
        id: "settings",
        label: "写入 ~/.codex/.env",
        detail: "终端 codex 和桌面客户端都读它；客户端要重启后生效",
        envOnlyEnough: true,
      },
      {
        id: "env",
        label: "不写，只给我环境变量",
        detail: "打印 export 语句，你自己决定怎么用",
        envOnlyEnough: true,
      },
    ];
  }

  if (app && app.envOnlyEnough === false) {
    return ACTIONS.filter((action) => action.id !== "env");
  }
  return ACTIONS;
}
