// 向导式界面：一次只做一件事，做完回车进入下一步。
//
// 之前是一屏四个步骤 + 数字键跳转，跳转本身就让人晕。
// 现在按顺序走：选工具 → 选上游代理 → 用代理启动 → 测连通 → 内网域名 → 完成。
// 每一步都要用户自己回车走完（即使状态已经就绪），流程才完整可见。

import { Box, Text } from "ink";
import { h, Card, txt, segments, useTheme, useUnicode } from "./ui.js";
import { padEnd } from "./width.js";
import { actionsFor } from "./app-menu.js";
import { findApp, codexProxyState } from "../core/apps.js";

export const STEP_TITLES = [
  "选一个要联网的工具",
  "代理要从哪个端口出去",
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
      // CLI 工具没有「在运行」这种状态，说清楚它是命令行工具就好
      const state = app.running
        ? "正在运行"
        : app.id === "codex"
          ? "命令行工具"
          : "没在运行";
      rows.push(
        option(
          theme,
          i === index,
          app.name,
          [app.version ?? "", state].filter(Boolean).join(" · "),
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

/**
 * 第 2 步：代理要从哪个端口出去。
 *
 * 这一步不能省。以前是自动探测完直接启动，用户根本不知道请求最后落到
 * 7897 还是 7890，出问题时也没法自己判断是不是选错了端口。
 *
 * 列表来自真实探测（系统代理 / mihomo API / 本机监听端口，且都验过协议），
 * 探测不到就让用户直接写 —— 不要假装「没检测到 = 一定没有」。
 */
export function StepUpstream({
  state,
  width,
  index,
  pinned,
  editing,
  draft,
  verifying,
  verifyResult,
}) {
  const theme = useTheme();
  const rows = [];
  const candidates = state.upstream?.candidates ?? [];

  if (editing) {
    rows.push([
      txt("  代理地址 ", { bold: true }),
      txt(draft || "", { color: theme.colors.accent }),
      txt("█", { color: theme.colors.accent }),
    ]);
    rows.push([txt("  ")]);
    rows.push([
      txt("  "),
      txt("回车确认 · Esc 取消 · 例：127.0.0.1:7897", { dim: true }),
    ]);
    if (verifyResult) {
      rows.push([txt("  ")]);
      rows.push([
        txt("  "),
        verifyResult.ok
          ? txt(`✔ ${verifyResult.detail}`, { color: theme.colors.ok })
          : txt(`✖ ${verifyResult.detail}`, { color: theme.colors.bad }),
      ]);
    }
    return h(StepFrame, {
      step: 2,
      title: STEP_TITLES[1],
      width,
      rows,
      footer: "输入代理的 host:port，回车确认",
    });
  }

  if (!candidates.length) {
    rows.push([txt("  "), txt("没探测到可用的代理", { color: theme.colors.warn })]);
    rows.push([txt("  ")]);
    rows.push([
      txt("  "),
      txt("先打开你的代理客户端（Clash / Surge / Stash / sing-box 都行）", { dim: true }),
    ]);
    rows.push([txt("  "), txt("按 m 直接填端口，或回车重新探测", { dim: true })]);
  } else {
    const widthName = Math.max(...candidates.map((c) => `${c.host}:${c.port}`.length)) + 2;
    candidates.forEach((c, i) => {
      const addr = `${c.host}:${c.port}`;
      const proto = (c.protocols ?? []).join("+") || "未知";
      rows.push(
        option(
          theme,
          i === index,
          addr,
          `${c.label ?? ""} · ${proto}`,
          widthName,
        ),
      );
    });
    rows.push([txt("  ")]);
    rows.push([txt("  "), txt("m 手动填一个端口", { dim: true })]);
  }

  if (pinned) {
    rows.push([txt("  ")]);
    rows.push([
      txt("  "),
      txt(`当前固定使用 ${pinned.host}:${pinned.port}`, { dim: true }),
    ]);
  }
  if (verifying) {
    rows.push([txt("  "), txt("正在验证这个代理能不能出网…", { dim: true })]);
  }

  return h(StepFrame, {
    step: 2,
    title: STEP_TITLES[1],
    width,
    rows,
    footer: "↑↓ 选择 · 回车确认 · m 手动填写 · Esc 上一步",
  });
}

/** 第 3 步：让它走代理 */
export function StepLaunch({ state, width, index, appName, appId, result, executing, live }) {
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
    [
      txt("  "),
      txt(padEnd("上游代理", 10), { dim: true }),
      state.upstream?.chosen
        ? txt(
            `${state.upstream.chosen.host}:${state.upstream.chosen.port}`,
            { bold: true },
          )
        : txt("没选（会重试自动探测）", { color: theme.colors.warn }),
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
    // 每个工具「认哪里的代理」不一样，这句话直接说清楚，
    // 比让用户去读文档有用。
    const why = {
      antigravity: "模型请求认 HTTPS_PROXY，只注入环境变量就能用",
      cursor: "模型请求不认环境变量代理，必须写 settings.json",
      codex: "终端命令和桌面客户端共用 ~/.codex/.env，优先级高于环境变量",
    }[app.id];
    rows.push([
      txt("  "),
      needsSettings
        ? txt(`▲ ${app.name}：${why}`, { color: theme.colors.warn })
        : txt(`✔ ${app.name}：${why}`, { color: theme.colors.ok }),
    ]);

    // 配置写的是什么，一眼可见
    if (app.id === "codex") {
      const state = codexProxyState(app);
      const onTunless = Boolean(state.httpsProxy?.includes(":8899"));
      rows.push([
        txt("  "),
        txt(padEnd("配置 .env", 12), { dim: true }),
        state.httpsProxy
          ? txt(state.httpsProxy, { color: onTunless ? theme.colors.ok : theme.colors.warn })
          : txt("没设置", { dim: true }),
      ]);
    }

    // 配置对了不等于生效，这里看的是进程的真实连接。
    const verdict = live?.verdict;
    if (verdict) {
      const portText = (verdict.ports ?? []).map((p) => `127.0.0.1:${p}`).join("、");
      const staleText = (verdict.stale ?? []).map((p) => `127.0.0.1:${p}`).join("、");
      rows.push([
        txt("  "),
        txt(padEnd("实际连接", 12), { dim: true }),
        verdict.state === "ok" && staleText
          ? txt(`已走 127.0.0.1:8899，但还有旧连接 ${staleText}`, { color: theme.colors.warn })
          : verdict.state === "ok"
            ? txt("已走 127.0.0.1:8899", { color: theme.colors.ok })
          : verdict.state === "stale"
            ? txt(`还连着 ${portText}，需要重启`, { color: theme.colors.warn })
            : verdict.state === "not-running"
              ? txt("应用没在运行", { dim: true })
              : txt("此刻没有代理连接（可能还没发请求）", { dim: true }),
      ]);
    }

    // 最后一公里：联网子进程有没有真的在用代理。
    // 只报「观察到的事实」，读不到就说读不到 —— 不猜。
    if (live?.netPid) {
      const env = live.env;
      rows.push([
        txt("  "),
        txt(padEnd("进程代理", 12), { dim: true }),
        env === null
          ? txt("读不到（没法判断）", { dim: true })
          : env.hasProxy === true
            ? txt(`✔ 正在使用 ${env.httpsProxy}`, { color: theme.colors.ok })
            : txt("此刻没有代理连接（可能还没发请求）", { dim: true }),
      ]);
    }
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
    step: 3,
    title: STEP_TITLES[2],
    width,
    rows,
    footer: result
      ? "回车下一步 · Esc 上一步"
      : "↑↓ 选择 · 回车执行 · Esc 上一步",
  });
}

/** 第 4 步：实测连通性 —— 按这个工具自己会连的域名逐个测 */
export function StepReach({ state, width, reachability, appName, editingTarget, draftTarget }) {
  const theme = useTheme();
  const rows = [];
  const reach = reachability;

  // 手动加测试目标时，整个卡片就是一行输入框
  if (editingTarget) {
    rows.push([
      txt("  测哪个域名？ ", { bold: true }),
      txt(draftTarget || "", { color: theme.colors.accent }),
      txt("█", { color: theme.colors.accent }),
    ]);
    rows.push([txt("  ")]);
    rows.push([
      txt("  "),
      txt("回车保存 · Esc 取消 · 例：api.example.com:8443/health", { dim: true }),
    ]);
    return h(StepFrame, {
      step: 4,
      title: STEP_TITLES[3],
      width,
      rows,
      footer: "直接输入，回车保存",
    });
  }

  if (!reach) {
    rows.push([txt("  "), txt("正在测…", { dim: true })]);
  } else if (reach.results?.length) {
    const nameWidth = Math.max(...reach.results.map((r) => r.host.length)) + 2;
    for (const r of reach.results) {
      // 可选目标不通时用灰点，避免让用户以为必需目标也挂了
      const opt = r.optional && !r.ok;
      const mark = opt
        ? txt("· ", { dim: true })
        : r.ok
          ? txt("✔ ", { color: theme.colors.ok })
          : txt("✖ ", { color: theme.colors.bad });
      rows.push([
        txt("  "),
        mark,
        txt(padEnd(r.host, nameWidth)),
        txt(r.label ?? "", { dim: true }),
        txt(`  ${r.ms}ms`, { dim: true }),
      ]);
    }
    rows.push([txt("  ")]);
    if (reach.ok) {
      rows.push([
        txt("  "),
        txt(
          `${appName ?? "这些目标"}要连的域名都能经代理访问`,
          { color: theme.colors.ok },
        ),
      ]);
    } else {
      const failed = (reach.failedRequired ?? []).map((r) => r.host);
      rows.push([
        txt("  "),
        txt(`不通：${failed.join("、") || "未知"}`, { color: theme.colors.bad }),
      ]);
      rows.push([
        txt("  "),
        txt("先看第 3 步有没有真的把代理注入进去", { dim: true }),
      ]);
    }
  } else if (reach.ok) {
    rows.push([txt("  "), txt(`✔ ${reach.detail}`, { color: theme.colors.ok })]);
  } else {
    rows.push([txt("  "), txt(`✖ ${reach.detail}`, { color: theme.colors.bad })]);
  }

  return h(StepFrame, {
    step: 4,
    title: STEP_TITLES[3],
    width,
    rows,
    footer: "回车下一步 · r 重测 · t 加一个要测的域名 · Esc 上一步",
  });
}

/** 第 5 步：内网域名 */
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
    step: 5,
    title: STEP_TITLES[4],
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
      reachability?.results?.length
        ? reachability.ok
          ? txt(
              `✔ ${reachability.results.filter((r) => r.ok).length}/${reachability.results.length} 个目标可达`,
              { color: theme.colors.ok },
            )
          : txt(
              `✖ ${reachability.failedRequired?.length ?? 0} 个目标不通`,
              { color: theme.colors.bad },
            )
        : reachability?.ok
          ? txt(`✔ ${reachability.detail}`, { color: theme.colors.ok })
          : txt("没测", { dim: true }),
    ],
    [
      txt("  "),
      txt(padEnd("内网域名", 10), { dim: true }),
      txt(`${state.internalDomains?.length ?? 0} 个已分流`, { color: theme.colors.ok }),
    ],
    [
      txt("  "),
      txt(padEnd("外网目标", 10), { dim: true }),
      reachability?.results?.length
        ? txt(
            `${reachability.results.filter((r) => r.ok).length}/${reachability.results.length} 可达`,
            { color: reachability.ok ? theme.colors.ok : theme.colors.warn },
          )
        : txt("没测", { dim: true }),
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

/**
 * 底部状态行。
 *
 * 放在底部、不放右上角，也不做转圈动画：
 * 转圈意味着每 100 多毫秒重画整屏，肉眼就是闪；
 * 而后台自动采集更不该用「正在执行」的语气，那会让人以为是自己触发的。
 */
export function StatusLine({ executing, progress, updatedAt }) {
  const theme = useTheme();
  const left = executing
    ? txt(`⟳ ${executing}`, { color: theme.colors.accent, bold: true })
    : progress
      ? txt(
          `正在${String(progress).replace(/^正在/, "").replace(/…+$/, "")}…（后台自动进行）`,
          { dim: true },
        )
      : txt(" ");

  const right = updatedAt
    ? txt(`更新于 ${updatedAt.toLocaleTimeString("zh-CN", { hour12: false })}`, { dim: true })
    : txt(" ");

  return h(
    Box,
    { flexDirection: "row", justifyContent: "space-between" },
    h(Text, null, ...segments([left], "s")),
    h(Text, null, ...segments([right], "r")),
  );
}
