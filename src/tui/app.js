// TUI 主程序：基于 ink 的图形界面。
//
// 负责整体布局、按键分发，以及刷新／修复／转发／服务／重启等操作。
//
// 主题：启动时用 OSC 11 询问终端背景色，按亮暗切换配色；
// 终端不支持 Unicode 时符号与边框降级成 ASCII。

import React, { useCallback, useEffect, useState } from "react";
import { render, renderToString, Box, Text, useApp, useInput, useStdout } from "ink";
import { h, ThemeProvider, Tabs, useTheme } from "./ui.js";
import { getTheme, detectUnicode } from "./theme.js";
import { queryTerminalColorScheme, themeFromEnv } from "./terminal-theme.js";
import {
  PANELS,
  OverviewPanel,
  DomainsPanel,
  ProcessesPanel,
  RoutesPanel,
  EventsPanel,
} from "./panels.js";
import { HelpPanel } from "./help.js";
import { isFirstRun, markSeen } from "./first-run.js";
import { collectState, emptyState } from "./state.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const PANEL_COMPONENTS = {
  overview: OverviewPanel,
  domains: DomainsPanel,
  processes: ProcessesPanel,
  routes: RoutesPanel,
  events: EventsPanel,
  help: HelpPanel,
};

const DEFAULT_HINT =
  "← → 切换面板 · r 刷新 · f 修复 · S 服务 · l 重启应用 · / 过滤 · 2 用法 · q 退出";

export function App({ internalDns, repoRoots = [], includeChrome = false }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const theme = useTheme();

  const [state, setState] = useState(emptyState);
  // 第一次运行时先看「怎么用」，避免一头雾水
  const [panel, setPanel] = useState(() => (isFirstRun() ? "help" : "overview"));
  const [events, setEvents] = useState([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [hint, setHint] = useState("");
  const [scroll, setScroll] = useState(0);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");

  const log = useCallback((text, kind = "info") => {
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    setEvents((prev) => {
      const next = [...prev, { time, text, kind }];
      return next.length > 200 ? next.slice(next.length - 200) : next;
    });
  }, []);

  const refresh = useCallback(async () => {
    setBusy(true);
    setProgress("正在启动…");
    try {
      const next = await collectState({
        internalDns,
        repoRoots,
        includeChrome,
        onProgress: (stage, partial) => {
          setProgress(stage);
          setState((prev) => ({ ...prev, ...partial }));
        },
      });
      setState(next);
      log(`状态已更新（内网域名 ${next.internalDomains.length} 个）`, "ok");
    } catch (err) {
      log(`刷新失败：${err.message}`, "bad");
    }
    setBusy(false);
    setProgress("");
  }, [internalDns, repoRoots, includeChrome, log]);

  const runFix = useCallback(async () => {
    log("开始诊断并生成修复方案…", "info");
    const { cmdFix, setQuiet } = await import("../cli.js");
    setQuiet(true);
    const code = await cmdFix(
      {
        _: ["fix"],
        flags: {
          "internal-dns": internalDns,
          "no-chrome": includeChrome ? false : true,
          yes: true,
        },
      },
      { quiet: true },
    );
    log(code === 0 ? "修复完成" : "修复未完成或已回滚", code === 0 ? "ok" : "warn");
    await refresh();
  }, [internalDns, includeChrome, log, refresh]);

  const runProxy = useCallback(async () => {
    if (state.sidecar.running) {
      log("转发服务已在运行", "warn");
      return;
    }
    log("正在启动转发服务…", "info");
    await exec(
      "launchctl",
      ["kickstart", "-k", `gui/${process.getuid?.() ?? 501}/dev.tunless.proxy`],
      { timeout: 15000 },
    ).catch((err) => {
      throw new Error(`启动失败：${err.message}`);
    });
    log("转发服务已启动", "ok");
    await refresh();
  }, [state.sidecar.running, log, refresh]);

  const runService = useCallback(async () => {
    log("正在切换转发服务状态…", "info");
    const domain = `gui/${process.getuid?.() ?? 501}/dev.tunless.proxy`;
    if (!state.sidecar.installed) {
      // 还没装成 launchd 服务，先装上（装完自动启动）
      const { cmdService, setQuiet } = await import("../cli.js");
      setQuiet(true);
      await cmdService({ _: ["service", "install"] }, { quiet: true });
      log("转发服务已安装并启动", "ok");
    } else if (state.sidecar.running) {
      await exec("launchctl", ["bootout", domain], { timeout: 15000 });
      log("转发服务已停止", "warn");
    } else {
      await exec("launchctl", ["kickstart", "-k", domain], { timeout: 15000 });
      log("转发服务已启动", "ok");
    }
    await refresh();
  }, [state.sidecar.running, state.sidecar.installed, log, refresh]);

  const runLaunch = useCallback(async () => {
    const app = "Antigravity";
    log(`正在以 tunless 代理重启 ${app}…`, "info");
    const { cmdLaunch, setQuiet } = await import("../cli.js");
    setQuiet(true);
    await cmdLaunch(
      {
        _: ["launch"],
        flags: {
          app,
          "internal-dns": internalDns,
          "no-chrome": includeChrome ? false : true,
        },
      },
      { quiet: true },
    );
    log(`${app} 已重启`, "ok");
    await refresh();
  }, [internalDns, includeChrome, log, refresh]);

  const runAction = useCallback(
    async (name) => {
      if (busy) {
        setHint("正在处理中，请稍候");
        return;
      }
      setBusy(true);
      setHint("");
      try {
        if (name === "refresh") await refresh();
        else if (name === "fix") await runFix();
        else if (name === "proxy") await runProxy();
        else if (name === "service") await runService();
        else if (name === "launch") await runLaunch();
      } catch (err) {
        log(`操作失败：${err.message}`, "bad");
      }
      setBusy(false);
    },
    [busy, refresh, runFix, runProxy, runService, runLaunch, log],
  );

  // 首次进入自动采集一次。
  useEffect(() => {
    refresh();
    markSeen();
  }, [refresh]);

  // 每秒刷新一次「更新于」时间显示。
  useEffect(() => {
    const timer = setInterval(() => setState((prev) => ({ ...prev })), 1000);
    return () => clearInterval(timer);
  }, []);

  /** 切换面板，并复位滚动与搜索 */
  const switchPanel = useCallback((id) => {
    setPanel(id);
    setScroll(0);
    setHint("");
  }, []);

  /** 左右方向键在面板之间循环切换 */
  const cyclePanel = useCallback(
    (step) => {
      const index = PANELS.findIndex((p) => p.id === panel);
      const next = PANELS[(index + step + PANELS.length) % PANELS.length];
      switchPanel(next.id);
    },
    [panel, switchPanel],
  );

  useInput((input, key) => {
    // 搜索模式：按键全部进入搜索框。
    if (searching) {
      if (key.escape) {
        setSearching(false);
        setQuery("");
        setScroll(0);
        return;
      }
      if (key.return) {
        setSearching(false);
        return;
      }
      if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1));
        setScroll(0);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setQuery((q) => q + input);
        setScroll(0);
      }
      return;
    }

    if (input === "q") {
      exit();
      return;
    }
    // 左右方向键切换面板
    if (key.leftArrow) {
      cyclePanel(-1);
      return;
    }
    if (key.rightArrow) {
      cyclePanel(1);
      return;
    }
    if (key.tab) {
      cyclePanel(1);
      return;
    }
    if (key.upArrow || input === "k") {
      setScroll((s) => Math.max(0, s - 1));
      return;
    }
    if (key.downArrow || input === "j") {
      setScroll((s) => s + 1);
      return;
    }
    if (key.pageUp) {
      setScroll((s) => Math.max(0, s - 10));
      return;
    }
    if (key.pageDown) {
      setScroll((s) => s + 10);
      return;
    }
    if (input === "/") {
      setSearching(true);
      setQuery("");
      setScroll(0);
      return;
    }

    const hit = PANELS.find((p) => p.key === input);
    if (hit) {
      switchPanel(hit.id);
      return;
    }
    if (input === "h" || input === "?") {
      switchPanel("help");
      return;
    }

    switch (input) {
      case "r":
        runAction("refresh");
        return;
      case "f":
        runAction("fix");
        return;
      case "p":
        runAction("proxy");
        return;
      case "S":
        runAction("service");
        return;
      case "l":
        runAction("launch");
        return;
      case "s":
        switchPanel("overview");
        return;
      default:
        break;
    }
  });

  const width = stdout.columns || 80;
  const rows = stdout.rows || 24;
  const bodyHeight = Math.max(4, rows - 7);

  const PanelComponent = PANEL_COMPONENTS[panel] ?? OverviewPanel;
  const panelProps = {
    state,
    width,
    height: bodyHeight,
    scroll,
    query,
    events,
  };

  const right = busy
    ? h(Text, { color: theme.colors.warn }, progress || "正在采集…")
    : state.updatedAt
      ? h(
          Text,
          { dimColor: true },
          `更新于 ${state.updatedAt.toLocaleTimeString("zh-CN", { hour12: false })}`,
        )
      : null;

  const helpText = panel === "help" ? "← 回到总览 · r 刷新 · q 退出" : DEFAULT_HINT;
  const help = searching
    ? h(Text, { color: theme.colors.info }, `搜索：${query}▏（回车确认，Esc 取消）`)
    : h(Text, { dimColor: true }, hint || helpText);

  return h(
    Box,
    { flexDirection: "column", height: rows },
    h(
      Box,
      { flexDirection: "row", justifyContent: "space-between" },
      h(Text, { color: theme.colors.accent, bold: true }, " tunless "),
      h(Text, { dimColor: true }, "Agent 免 TUN 联网 · 不知道从哪开始就按 2 看用法"),
      right,
    ),
    h(Tabs, { items: PANELS, activeId: panel }),
    h(
      Box,
      { flexDirection: "column", flexGrow: 1, overflow: "hidden" },
      h(PanelComponent, panelProps),
    ),
    h(Box, { flexDirection: "column" }, help, h(Text, { dimColor: true }, " ")),
  );
}

/**
 * 启动图形界面。
 * 先询问终端背景色确定主题，再开始渲染。
 */
export async function runTui(options = {}) {
  const unicode = detectUnicode();
  const scheme = themeFromEnv() ?? (await queryTerminalColorScheme());
  const theme = getTheme(scheme ?? "dark");

  // 调试模式：每帧以纯文本追加输出，方便在没有终端模拟器时观察界面内容。
  const debug = process.env.TUNLESS_TUI_DEBUG === "1";
  const instance = render(
    h(ThemeProvider, { theme, unicode }, h(App, options)),
    {
      alternateScreen: !debug,
      debug,
      exitOnCtrlC: true,
    },
  );
  await instance.waitUntilExit();
  return 0;
}

/**
 * 非交互环境（管道、CI）下输出纯文本总览。
 * 没有 TTY 时 ink 的交互界面无法启动，退化成一份可直接阅读的文本。
 */
export async function renderStaticSummary(options = {}) {
  const unicode = detectUnicode();
  const theme = getTheme(themeFromEnv() ?? "dark");
  const state = await collectState({
    internalDns: options.internalDns,
    repoRoots: options.repoRoots ?? [],
    includeChrome: options.includeChrome ?? false,
  });

  const width = Math.min(process.stdout.columns || 100, 110);
  const head = renderToString(
    h(ThemeProvider, { theme, unicode }, h(OverviewPanel, { state, width })),
  );

  const nameWidth = Math.max(
    20,
    ...state.internalDomains.map((d) => d.name.length),
  );
  const domains = state.internalDomains.length
    ? state.internalDomains
        .map((d) => `  ${d.name.padEnd(nameWidth)}  ${d.ips.join(", ")}`)
        .join("\n")
    : "  （无）";

  return `${head}\n内网域名\n${domains}\n`;
}
