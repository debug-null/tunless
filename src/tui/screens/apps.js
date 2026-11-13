// 工具屏：已安装应用一览（list）→ 单应用动作（actions）两段式钻取屏。
//
// 行格式平移自向导的 StepApps / StepLaunch —— 向导是「一次过」的流程，
// 这里是常驻的操作入口：看一眼谁在走代理、谁还挂着旧代理，回车进来处理它，
// Esc 逐级后退（actions → list → dashboard）。
//
// 三态诚实跟向导同一套：live.verdict 是进程的真实连接（ok/stale/not-running/
// unknown），配置写对不代表生效，读不到就说读不到。
import { Box, Text } from "ink";
import { h, useTheme, useUnicode, txt, segments, Section, optionRow } from "../ui.js";
import { symbolSet } from "../theme.js";
import { displayWidth, padEnd } from "../width.js";
import { rowsFor } from "../../core/status-rows.js";
import { StatusRow } from "../components/status-row.js";
import { actionsFor } from "../app-menu.js";
import { findApp, codexProxyState } from "../../core/apps.js";

/** list 阶段的行：StepApps 的行格式（installed 过滤、版本·状态·走代理标记） */
function listRows(theme, arrow, apps, cursor) {
  const rows = [];
  if (!apps.length) {
    rows.push([txt("  "), txt("没有检测到 Antigravity / Cursor", { dim: true })]);
    rows.push([txt("  "), txt("装好之后再回来，或用命令行：tunless launch Cursor", { dim: true })]);
    return rows;
  }
  const nameWidth = Math.max(...apps.map((a) => a.name.length)) + 2;
  apps.forEach((app, i) => {
    // CLI 工具没有「在运行」这种状态，说清楚它是命令行工具就好
    const stateText = app.running
      ? "正在运行"
      : app.id === "codex"
        ? "命令行工具"
        : "没在运行";
    // 最要紧的一条信息：它现在是不是已经走着 tunless 的代理。
    const proxied =
      app.proxied === "ok"
        ? " ✔ 已走代理"
        : app.proxied === "stale"
          ? " ⚠ 还连着旧代理"
          : "";
    rows.push(
      optionRow(
        theme,
        i === cursor,
        app.name,
        [app.version ?? "", stateText].filter(Boolean).join(" · ") + proxied,
        nameWidth,
        { arrow },
      ),
    );
  });
  return rows;
}

/** actions 阶段的行：StepLaunch 的信息区（服务/上游/why/真实连接）+ 动作选项 */
function actionRows(theme, arrow, { state, appName, appId, live, result, executing, actionIndex, width }) {
  const side = state.sidecar ?? {};
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
      const codexState = codexProxyState(app);
      const onTunless = Boolean(codexState.httpsProxy?.includes(":8899"));
      rows.push([
        txt("  "),
        txt(padEnd("配置 .env", 12), { dim: true }),
        codexState.httpsProxy
          ? txt(codexState.httpsProxy, { color: onTunless ? theme.colors.ok : theme.colors.warn })
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
    // 屏上没有「下一步」：回车是「看完了，回动作列表」，不是推进流程。
    rows.push([txt("  "), txt("回车继续 · Esc 返回列表", { dim: true })]);
  } else if (!side.running) {
    rows.push([txt("  "), txt("回车启动转发服务", { dim: true })]);
  } else {
    const actions = actionsFor(app?.id);
    // label 是中文：按显示宽度算列宽；detail 给宽度预算截断，
    // 不然 80 列终端上 ink 会从行中间拦腰断词。
    const labelWidth = Math.max(...actions.map((a) => displayWidth(a.label))) + 2;
    const detailWidth = Math.max(8, (width ?? 80) - labelWidth - 7);
    // 高亮和回车取值用同一个 clamp
    const cursor = Math.min(Math.max(0, actionIndex), Math.max(0, actions.length - 1));
    actions.forEach((action, i) => {
      rows.push(
        optionRow(theme, i === cursor, action.label, action.detail, labelWidth, {
          arrow,
          detailWidth,
        }),
      );
    });
  }
  return rows;
}

export function AppsScreen({
  state,
  width = 80,
  appIndex = 0,
  appName = null,
  appId = null,
  stage = "list",
  actionIndex = 0,
  live = null,
  result = null,
  executing = null,
}) {
  const theme = useTheme();
  const arrow = symbolSet(useUnicode()).arrow;
  const apps = (state.apps ?? []).filter((a) => a.installed);

  if (stage === "actions") {
    const rows = actionRows(theme, arrow, {
      state,
      appName,
      appId,
      live,
      result,
      executing,
      actionIndex,
      width,
    });
    return h(
      Box,
      { flexDirection: "column" },
      h(Text, { color: theme.colors.accent, bold: true }, ` ${appName ?? "工具"}`),
      h(Text, null, " "),
      ...rows.map((line, i) => h(Text, { key: i }, ...segments(line))),
    );
  }

  const toolsRow = rowsFor(state).find((r) => r.id === "tools") ?? {
    status: "unknown",
    label: "工具",
    detail: "",
  };
  // 光标跟着 appIndex 走但要夹在列表内：外部刷新后列表变短，
  // 高亮不能停在空气上（回车选中时也是按这个夹值取应用）。
  const cursor = Math.min(Math.max(0, appIndex), Math.max(0, apps.length - 1));
  const rows = listRows(theme, arrow, apps, cursor);

  return h(
    Box,
    { flexDirection: "column" },
    h(Text, { color: theme.colors.accent, bold: true }, " 工具"),
    h(Text, null, " "),
    // 行内 action（回车看详情）是仪表盘语境，本屏按键看底部 KeyBar。
    h(StatusRow, { row: { ...toolsRow, action: null }, selected: false, width }),
    h(
      Section,
      { title: "已安装的工具" },
      ...rows.map((line, i) => h(Text, { key: i }, ...segments(line))),
    ),
  );
}
