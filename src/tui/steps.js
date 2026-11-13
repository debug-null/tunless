// 向导式界面：一次只做一件事，做完回车进入下一步。
//
// 之前是一屏四个步骤 + 数字键跳转，跳转本身就让人晕。
// 现在按顺序走：选工具 → 用代理启动 → 测连通 → 内网域名 → 完成。
// 每一步都要用户自己回车走完（即使状态已经就绪），流程才完整可见。

import { Box, Text } from "ink";
import { h, Card, txt, segments, useTheme, useUnicode } from "./ui.js";
import { padEnd } from "./width.js";
import { actionsFor } from "./app-menu.js";
import { findApp } from "../core/apps.js";

export const STEP_TITLES = [
  "选一个要联网的工具",
  "让它走 tunless 的代理",
  "实测外网通不通",
  "看看内网域名",
];

export const TOTAL_STEPS = STEP_TITLES.length;

/** 步骤外框：标题写清楚「第几步 / 共几步」 */
function StepFrame({ step, title, width, rows, footer }) {
  const theme = useTheme();
  const cardWidth = Math.max(56, Math.min(width - 2, 110));
  return h(
    Box,
    { flexDirection: "column" },
    h(
      Text,
      { dimColor: true },
      `  第 ${step} 步 / 共 ${TOTAL_STEPS} 步`,
    ),
    h(Text, null, " "),
    h(Card, { title, width: cardWidth, rows }),
    footer ? h(Text, null, " ") : null,
    footer ? h(Text, { dimColor: true }, `  ${footer}`) : null,
  );
}

/** 指针行：❯ 表示当前选中 */
function option(theme, selected, title, detail, titleWidth) {
  return [
    txt("  "),
    txt(selected ? "❯ " : "  ", { color: selected ? theme.colors.accent : undefined }),
    txt(padEnd(title, titleWidth), {
      bold: selected,
      color: selected ? theme.colors.accent : undefined,
    }),
    detail ? txt("   " + detail, { dim: true }) : null,
  ].filter(Boolean);
}

/** 第 1 步：选工具 */
export function StepApps({ state, width, index }) {
  const theme = useTheme();
  const apps = (state.apps ?? []).filter((a) => a.installed);
  const rows = [];

  if (!apps.length) {
    rows.push([txt("  "), txt("没有检测到 Antigravity / Cursor", { dim: true })]);
    rows.push([txt("  "), txt("装好之后再回来，或用命令行：tunless launch Cursor", { dim: true })]);
  } else {
    const nameWidth = Math.max(...apps.map((a) => a.name.length)) + 2;
    apps.forEach((app, i) => {
      rows.push(
        option(
          theme,
          i === index,
          app.name,
          [
            app.version ?? "",
            app.running ? "正在运行" : "没在运行",
          ]
            .filter(Boolean)
            .join(" · "),
          nameWidth,
        ),
      );
    });
  }

  return h(StepFrame, {
    step: 1,
    title: STEP_TITLES[0],
    width,
    rows,
    footer: "↑↓ 选择 · 回车下一步 · q 退出",
  });
}

/** 第 2 步：让它走代理 */
export function StepLaunch({ state, width, index, appName, appId, result, executing }) {
  const theme = useTheme();
  const side = state.sidecar;
  const rows = [];

  rows.push(
    [
      txt("  "),
      txt(padEnd("转发服务", 10), { dim: true }),
      side.running
        ? txt(`✔ 运行中（HTTP ${side.httpPort} · SOCKS5 ${side.socksPort}）`, {
            color: theme.colors.ok,
          })
        : txt("▲ 没在运行", { color: theme.colors.warn }),
    ],
    [txt("  ")],
    [
      txt("  "),
      txt(padEnd("目标工具", 10), { dim: true }),
      txt(appName ?? "（还没选）", { bold: true }),
    ],
    [txt("  ")],
  );

  // 这个应用到底要不要写配置文件？答案直接写在界面上，
  // 用户不用去猜「只注入环境变量到底行不行」。
  const app = findApp(appId ?? appName ?? "");
  const needsSettings = app ? app.envOnlyEnough === false : false;
  if (app) {
    rows.push([
      txt("  "),
      needsSettings
        ? txt(`▲ ${app.name} 的模型请求不认环境变量代理，所以下面只列能用的方式`, {
            color: theme.colors.warn,
          })
        : txt(`✔ ${app.name} 只注入环境变量就能用`, { color: theme.colors.ok }),
    ]);
    rows.push([txt("  ")]);
  }

  if (executing) {
    rows.push([txt("  "), txt(`⟳ ${executing}`, { color: theme.colors.accent, bold: true })]);
    rows.push([txt("  ")]);
    rows.push([txt("  "), txt("等它跑完…", { dim: true })]);
  } else if (result) {
    rows.push([txt("  "), txt(result, { color: theme.colors.ok })]);
    rows.push([txt("  ")]);
    rows.push([txt("  "), txt("回车进入下一步", { dim: true })]);
  } else if (!side.running) {
    rows.push([txt("  "), txt("回车启动转发服务", { dim: true })]);
  } else {
    const actions = actionsFor(app?.id);
    const labelWidth = Math.max(...actions.map((a) => a.label.length)) + 2;
    actions.forEach((action, i) => {
      rows.push(option(theme, i === index, action.label, action.detail, labelWidth));
    });
  }

  return h(StepFrame, {
    step: 2,
    title: STEP_TITLES[1],
    width,
    rows,
    footer: result
      ? "回车下一步 · Esc 上一步"
      : "↑↓ 选择 · 回车执行 · Esc 上一步",
  });
}

/** 第 3 步：实测连通性 */
export function StepReach({ state, width, reachability }) {
  const theme = useTheme();
  const rows = [];
  const reach = reachability;

  if (!reach) {
    rows.push([txt("  "), txt("正在测…", { dim: true })]);
  } else if (reach.ok) {
    rows.push([txt("  "), txt(`✔ ${reach.detail}`, { color: theme.colors.ok })]);
    rows.push([txt("  "), txt(`耗时 ${reach.ms}ms`, { dim: true })]);
  } else {
    rows.push([txt("  "), txt(`✖ ${reach.detail}`, { color: theme.colors.bad })]);
    rows.push([txt("  ")]);
    rows.push([txt("  "), txt("r 重测 · 回车下一步（不通也可以先往下走）", { dim: true })]);
  }

  return h(StepFrame, {
    step: 3,
    title: STEP_TITLES[2],
    width,
    rows,
    footer: "回车下一步 · r 重测 · Esc 上一步",
  });
}

/** 第 4 步：内网域名 */
export function StepDomains({ state, width }) {
  const theme = useTheme();
  const domains = state.internalDomains ?? [];
  const rows = [];

  if (!domains.length) {
    rows.push([txt("  "), txt("没扫到内网域名", { dim: true })]);
    rows.push([txt("  "), txt("多半是没给终端完全磁盘访问权限，也可以按 a 手写一条", { dim: true })]);
  } else {
    const nameWidth = Math.max(...domains.map((d) => d.name.length)) + 2;
    for (const domain of domains.slice(0, 10)) {
      rows.push([
        txt("  "),
        txt("✔ ", { color: theme.colors.ok }),
        txt(padEnd(domain.name, nameWidth)),
        txt(domain.ips?.[0] ?? "", { dim: true }),
      ]);
    }
    if (domains.length > 10) {
      rows.push([txt("  "), txt(`…… 还有 ${domains.length - 10} 个`, { dim: true })]);
    }
    rows.push([txt("  ")]);
    rows.push([txt("  "), txt("这些域名走直连，不进代理", { dim: true })]);
  }

  const manual = Object.values(state.rules ?? {}).reduce(
    (sum, list) => sum + (list?.length ?? 0),
    0,
  );
  if (manual) {
    rows.push([txt("  "), txt(`你手写的规则 ${manual} 条也生效`, { dim: true })]);
  }

  return h(StepFrame, {
    step: 4,
    title: STEP_TITLES[3],
    width,
    rows,
    footer: "a 手写一条域名 · 回车完成 · Esc 上一步",
  });
}

/** 收尾页 */
export function StepDone({ state, width, appName, reachability }) {
  const theme = useTheme();
  const rows = [
    [
      txt("  "),
      txt(padEnd("工具", 10), { dim: true }),
      txt(appName ?? "（没选）", { bold: true }),
    ],
    [
      txt("  "),
      txt(padEnd("外网", 10), { dim: true }),
      reachability?.ok
        ? txt(`✔ ${reachability.detail}`, { color: theme.colors.ok })
        : txt("没测", { dim: true }),
    ],
    [
      txt("  "),
      txt(padEnd("内网域名", 10), { dim: true }),
      txt(`${state.internalDomains?.length ?? 0} 个已分流`, { color: theme.colors.ok }),
    ],
    [txt("  ")],
    [txt("  "), txt("回车重新开始 · q 退出", { dim: true })],
  ];

  return h(
    Box,
    { flexDirection: "column" },
    h(Text, { color: theme.colors.ok, bold: true }, "  ✔ 全部搞定"),
    h(Text, null, " "),
    h(Card, { title: "结果", width: Math.max(56, Math.min(width - 2, 110)), rows }),
  );
}
