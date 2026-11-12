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
import { PANELS, OverviewPanel } from "./panels.js";
import { HelpPanel } from "./help.js";
import { RulesPanel, MorePanel } from "./rules-panel.js";
import { addRule, removeRule, saveRules, loadRules, RULE_KINDS } from "../core/rules.js";
import { isFirstRun, markSeen } from "./first-run.js";
import { collectState, emptyState } from "./state.js";
import { startService, stopService } from "../core/launchd.js";
const PANEL_COMPONENTS = {
  overview: OverviewPanel,
  rules: RulesPanel,
  more: MorePanel,
  help: HelpPanel,
};

const DEFAULT_HINT = "← → 换页 · s 开关转发服务 · a 加内网域名 · f 修 DNS · q 退出";

/** 按 l 能依次启动的应用；这些是实际验证过「靠环境变量/配置能走代理」的 */
const APP_CHOICES = ["Antigravity", "Cursor"];

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
  // 手动加规则：editing 存规则类型（domain/keyword/cidr），null 表示没在输入
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState("");
  const [ruleIndex, setRuleIndex] = useState(0);
  const [appChoice, setAppChoice] = useState(0);

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
    if (!state.sidecar.installed) {
      const { cmdService, setQuiet } = await import("../cli.js");
      setQuiet(true);
      await cmdService({ _: ["service", "install"] }, { quiet: true });
    } else {
      await startService();
    }
    log("转发服务已启动", "ok");
    await refresh();
  }, [state.sidecar.running, state.sidecar.installed, log, refresh]);

  const runService = useCallback(async () => {
    log("正在切换转发服务状态…", "info");
    try {
      if (!state.sidecar.installed) {
        // 还没装成 launchd 服务，先装上（装完自动启动）
        const { cmdService, setQuiet } = await import("../cli.js");
        setQuiet(true);
        await cmdService({ _: ["service", "install"] }, { quiet: true });
        log("转发服务已安装并启动", "ok");
        setHint("转发服务已安装并启动，监听 127.0.0.1:8899");
      } else if (state.sidecar.running) {
        await stopService();
        log("转发服务已停止", "warn");
        setHint("转发服务已停止，再按 s 可以重新启动");
      } else {
        await startService();
        log("转发服务已启动", "ok");
        setHint("转发服务已启动，监听 127.0.0.1:8899");
      }
    } catch (err) {
      log(`切换转发服务失败：${err.message}`, "bad");
      setHint(`切换失败：${err.message}`);
    }
    await refresh();
  }, [state.sidecar.running, state.sidecar.installed, log, refresh]);

  const launchApp = useCallback(async (app) => {
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
    setHint(
      app === "Cursor"
        ? "Cursor 已带代理启动，发一条消息试试模型能不能回"
        : `${app} 已带代理启动`,
    );
    await refresh();
  }, [internalDns, includeChrome, log, refresh]);

  /** 按 l 依次在受支持的应用之间切换，避免用户不知道能启动哪个 */
  const runLaunch = useCallback(async () => {
    const app = APP_CHOICES[appChoice % APP_CHOICES.length];
    setAppChoice((i) => i + 1);
    await launchApp(app);
  }, [appChoice, launchApp]);

  /** Cursor 专用：改 settings.json + 关 HTTP/2 + 带代理重启 */
  const runCursor = useCallback(async () => {
    log("正在配置 Cursor 代理…", "info");
    const { configureCursor, setQuiet } = await import("../cli.js");
    setQuiet(true);
    const { quitApp, openApp, findApp } = await import("../core/apps.js");
    const result = await configureCursor({
      proxyUrl: "http://127.0.0.1:8899",
      yes: true,
      quiet: true,
    });
    if (!result.ok) {
      log("Cursor 配置失败", "bad");
      setHint("Cursor 配置失败：先打开一次 Cursor 生成配置");
      return;
    }
    const app = findApp("cursor");
    const quitResult = await quitApp(app);
    if (!quitResult.quit) {
      log(`Cursor 没能退出（pid ${quitResult.pid}）`, "bad");
      setHint("Cursor 没能退出，请手动 Cmd+Q 后再按 L（配置已写好）");
      return;
    }
    if (quitResult.escalated) log("Cursor 忽略正常退出，已强制关闭", "warn");
    await new Promise((r) => setTimeout(r, 2000));
    await openApp(app, {
      HTTPS_PROXY: "http://127.0.0.1:8899",
      HTTP_PROXY: "http://127.0.0.1:8899",
      https_proxy: "http://127.0.0.1:8899",
      http_proxy: "http://127.0.0.1:8899",
    });
    log("Cursor 已配置并带着代理重启", "ok");
    setHint("Cursor 已带代理重启，发一条消息试试模型能不能回");
    await refresh();
  }, [log, refresh]);

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
        else if (name === "cursor") await runCursor();
      } catch (err) {
        log(`操作失败：${err.message}`, "bad");
      }
      setBusy(false);
    },
    [busy, refresh, runFix, runProxy, runService, runLaunch, runCursor, log],
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

  /** 规则面板里「按顺序能选到」的全部规则，供删除使用 */
  const flatRules = useCallback(() => {
    const rules = state.rules ?? { domain: [], keyword: [], cidr: [] };
    return RULE_KINDS.flatMap((kind) => (rules[kind] ?? []).map((value) => ({ kind, value })));
  }, [state.rules]);

  const saveDraft = useCallback(() => {
    const value = draft.trim();
    if (!value) {
      setEditing(null);
      setDraft("");
      return;
    }
    try {
      const { rules, rule, added } = addRule(loadRules(), value, editing);
      saveRules(rules);
      setState((prev) => ({ ...prev, rules }));
      log(
        added ? `已添加内网规则：${rule.value}` : `规则已存在：${rule.value}`,
        added ? "ok" : "warn",
      );
      setHint(
        added
          ? `已保存 ${rule.value} · 重启转发服务后生效（按 s 两次）`
          : `${rule.value} 已经在规则里了`,
      );
    } catch (err) {
      setHint(`保存失败：${err.message}`);
      setEditing(editing);
      return;
    }
    setEditing(null);
    setDraft("");
  }, [draft, editing, log]);

  const deleteRule = useCallback(() => {
    const list = flatRules();
    if (!list.length) {
      setHint("还没有手动规则可删");
      return;
    }
    const target = list[ruleIndex % list.length];
    try {
      const { rules, removed } = removeRule(loadRules(), target.value, target.kind);
      saveRules(rules);
      setState((prev) => ({ ...prev, rules }));
      log(removed ? `已删除规则：${target.value}` : `没有这条规则：${target.value}`, removed ? "warn" : "bad");
      setHint(removed ? `已删除 ${target.value}` : `没有找到 ${target.value}`);
      setRuleIndex(0);
    } catch (err) {
      setHint(`删除失败：${err.message}`);
    }
  }, [flatRules, ruleIndex, log]);

  useInput((input, key) => {
    // 输入规则：所有按键都进输入框，Tab 在三种类型之间切换
    if (editing) {
      if (key.escape) {
        setEditing(null);
        setDraft("");
        return;
      }
      if (key.return) {
        saveDraft();
        return;
      }
      if (key.tab) {
        const index = RULE_KINDS.indexOf(editing);
        setEditing(RULE_KINDS[(index + 1) % RULE_KINDS.length]);
        return;
      }
      if (key.backspace || key.delete) {
        setDraft((v) => v.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setDraft((v) => v + input);
      }
      return;
    }

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
      if (panel === "rules") {
        setRuleIndex((i) => Math.max(0, i - 1));
      } else {
        setScroll((s) => Math.max(0, s - 1));
      }
      return;
    }
    if (key.downArrow || input === "j") {
      if (panel === "rules") {
        const total = RULE_KINDS.reduce((sum, kind) => sum + ((state.rules?.[kind] ?? []).length), 0);
        setRuleIndex((i) => Math.min(Math.max(0, total - 1), i + 1));
      } else {
        setScroll((s) => s + 1);
      }
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
    // a：任何页面都能直接加内网规则。这是「不想授权也能用」的主入口。
    if (input === "a") {
      setEditing("domain");
      setDraft("");
      setHint("");
      return;
    }
    if (input === "d" && panel === "rules") {
      deleteRule();
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
      // 服务开关：大小写都接受。之前只有大写 S 有效，
      // 而小写 s 被当成「回到总览」，按下去看起来毫无反应。
      case "s":
      case "S":
        runAction("service");
        return;
      case "l":
        runAction("launch");
        return;
      case "L":
        runAction("cursor");
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
    editing,
    draft,
    ruleIndex,
    appChoice,
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
      h(Text, { dimColor: true }, "Agent 免 TUN 联网 · 按 s 开服务，按 l 开应用，按 a 加内网域名"),
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

  // ink 在非 TTY 下按 80 列排版，这里必须用同一个宽度，
  // 否则我们自己算的 100 列会和它的 80 列打架，并排卡片直接被折行。
  const width = Math.min(process.stdout.columns || 80, 110);
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
