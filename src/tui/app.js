// TUI 主程序：基于 ink 的图形界面。
//
// 交互是「向导式」的：一次只做一件事，回车走完这一步再进下一步。
//   1 选工具 → 2 用代理启动 → 3 测连通 → 4 内网域名 → 完成
// 之前是一屏四步 + 数字键跳转，跳转本身就让人晕。
//
// 主题：启动时用 OSC 11 询问终端背景色，按亮暗切换配色；
// 终端不支持 Unicode 时符号与边框降级成 ASCII。

import React, { useCallback, useEffect, useState } from "react";
import { render, renderToString, Box, Text, useApp, useInput, useStdout } from "ink";
import { h, ThemeProvider, useTheme } from "./ui.js";
import { getTheme, detectUnicode } from "./theme.js";
import { queryTerminalColorScheme, themeFromEnv } from "./terminal-theme.js";
import { OverviewPanel } from "./panels.js";
import {
  StepApps,
  StepLaunch,
  StepReach,
  StepDomains,
  StepDone,
  StatusLine,
  TOTAL_STEPS,
} from "./steps.js";
import { HelpPanel } from "./help.js";
import { actionsFor } from "./app-menu.js";
import {
  APPS,
  findApp,
  appProxyPorts,
  proxyVerdict,
  mainPid,
  networkPid,
  processProxyEnv,
} from "../core/apps.js";
import { addRule, removeRule, saveRules, loadRules, RULE_KINDS } from "../core/rules.js";
import { markSeen } from "./first-run.js";
import { collectState, emptyState } from "./state.js";
import { startService, stopService } from "../core/launchd.js";
import { checkReachability } from "../core/reach.js";

export function App({ internalDns, repoRoots = [], includeChrome = false }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const theme = useTheme();

  const [state, setState] = useState(emptyState);
  // 向导状态：step 是当前第几步，done 是收尾页。
  const [step, setStep] = useState(1);
  const [done, setDone] = useState(false);
  // 第 1 步选中的应用
  const [appIndex, setAppIndex] = useState(0);
  const [appName, setAppName] = useState(null);
  const [appId, setAppId] = useState(null);
  // 第 2 步：选中的处理方式 + 执行结果
  const [actionIndex, setActionIndex] = useState(0);
  const [stepResult, setStepResult] = useState(null);
  // 第 3 步：连通性实测结果
  const [reach, setReach] = useState(null);
  // 选中的工具此刻的真实连接：进程在不在、实际连的是哪个本地代理端口。
  // 配置写对了不代表生效了，所以这一步必须看进程，不看文件。
  const [live, setLive] = useState(null);
  // 用户主动触发的动作（重启应用 / 写配置 / 测连通），走底部状态行
  const [executing, setExecuting] = useState(null);
  const [events, setEvents] = useState([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [hint, setHint] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  // 手动加规则：editing 存规则类型（domain/keyword/cidr），null 表示没在输入
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState("");
  const [ruleIndex, setRuleIndex] = useState(0);

  const log = useCallback((text, kind = "info") => {
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    setEvents((prev) => {
      const next = [...prev, { time, text, kind }];
      return next.length > 200 ? next.slice(next.length - 200) : next;
    });
  }, []);

  /**
   * 只刷新「选中工具的真实连接」。
   * 采集整个状态要做 DNS 探测和目录扫描，很慢；写完配置后只需要这一小块。
   */
  const refreshLive = useCallback(async (id = appId) => {
    const target = id ? findApp(id) : null;
    if (!target) {
      setLive(null);
      return null;
    }
    try {
      const conn = await appProxyPorts(target);
      // 光有连接还不够：得看联网子进程的环境里到底有没有代理。
      // 没有的话它会去直连真实 IP，报 `dial tcp … i/o timeout`，
      // 而界面还显示「已走 8899」，完全是误导。
      const netPid = await networkPid(target);
      const env = await processProxyEnv(netPid);
      const next = { ...conn, verdict: proxyVerdict(conn), netPid, env };
      setLive(next);
      return next;
    } catch {
      setLive(null);
      return null;
    }
  }, [appId]);

  const refresh = useCallback(async () => {
    setBusy(true);
    setProgress("正在采集…");
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
      await refreshLive();
      log(`状态已更新（内网域名 ${next.internalDomains.length} 个）`, "ok");
    } catch (err) {
      log(`刷新失败：${err.message}`, "bad");
    }
    setBusy(false);
    setProgress("");
  }, [internalDns, repoRoots, includeChrome, log, refreshLive]);

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
      return true;
    }
    log("正在启动转发服务…", "info");
    try {
      if (!state.sidecar.installed) {
        const { cmdService, setQuiet } = await import("../cli.js");
        setQuiet(true);
        await cmdService({ _: ["service", "install"] }, { quiet: true });
      } else {
        await startService();
      }
    } catch (err) {
      log(`转发服务启动失败：${err.message}`, "bad");
      setHint(`转发服务启动失败：${err.message}`);
      return false;
    }
    log("转发服务已启动", "ok");
    await refresh();
    return true;
  }, [state.sidecar.running, state.sidecar.installed, log, refresh]);

  const runService = useCallback(async () => {
    log("正在切换转发服务状态…", "info");
    try {
      if (!state.sidecar.installed) {
        const { cmdService, setQuiet } = await import("../cli.js");
        setQuiet(true);
        await cmdService({ _: ["service", "install"] }, { quiet: true });
        log("转发服务已安装并启动", "ok");
        setHint("转发服务已安装并启动，监听 127.0.0.1:8899");
      } else if (state.sidecar.running) {
        await stopService();
        log("转发服务已停止", "warn");
        setHint("转发服务已停止，再按 S 可以重新启动");
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

  /**
   * 带代理启动应用。
   * writeSettings 决定要不要改应用自己的配置文件 —— 由用户在菜单里选，
   * 工具不擅自决定。
   */
  const launchApp = useCallback(
    async (app, { writeSettings = false } = {}) => {
      log(`正在以 tunless 代理重启 ${app}…`, "info");
      const { cmdLaunch, setQuiet } = await import("../cli.js");
      setQuiet(true);
      const code = await cmdLaunch(
        {
          _: ["launch"],
          flags: {
            app,
            "internal-dns": internalDns,
            "no-chrome": includeChrome ? false : true,
            "write-settings": writeSettings,
          },
        },
        { quiet: true },
      );
      if (code !== 0) {
        log(`${app} 启动失败（退出码 ${code}）`, "bad");
        await refresh();
        return { ok: false, code };
      }

      // 不要只相信「命令跑完没报错」。真的去看进程在不在 ——
      // 之前 open 失败被吞掉，界面照样说「已重启」，用户看到的就是
      // 「根本没自动拉起」。
      const target = findApp(app);
      const alive = target ? await mainPid(target) : null;
      if (!alive) {
        log(`${app} 没有起来：没找到运行中的进程`, "bad");
        await refresh();
        return { ok: false, reason: "not-running" };
      }

      log(`${app} 已重启（pid ${alive}）`, "ok");
      await refresh();
      return { ok: true, pid: alive };
    },
    [internalDns, includeChrome, log, refresh],
  );

  /** 第 2 步里执行选中的处理方式 */
  const applyAppAction = useCallback(
    async (app, actionId) => {
      if (!app) return null;
      if (actionId === "env" || actionId === "env+settings") {
        const launched = await launchApp(app.name, { writeSettings: actionId === "env+settings" });
        if (!launched?.ok) {
          setHint(
            app.id === "codex" || app.name === "Codex"
              ? "写入 .env 失败，检查一下文件权限"
              : `${app.name} 没能启动。手动打开它，或用 tunless launch ${app.name} 看详细报错`,
          );
          // 返回 null 表示「这一步没成功」：界面不该打勾，用户应该能重试。
          return null;
        }
        return app.id === "codex" || app.name === "Codex"
          ? "Codex 的代理已写入 .env，新开终端跑 codex 就生效"
          : actionId === "env"
            ? `${app.name} 已带代理启动（pid ${launched.pid}）`
            : `${app.name} 已带代理启动（pid ${launched.pid}），并写入代理配置`;
      }
      // Codex 的「只给我环境变量」：打印出来，不写文件
      if (actionId === "env" && (app.id === "codex" || app.name === "Codex")) {
        const envLines = [
          `export HTTPS_PROXY=http://127.0.0.1:8899`,
          `export HTTP_PROXY=http://127.0.0.1:8899`,
          `export NO_PROXY=localhost,127.0.0.1,::1,.local`,
        ];
        setHint(`复制到你的 shell：${envLines.join("  ")}`);
        log(`Codex 环境变量（注意：.env 会覆盖它们，可能需要先清空 .env）`, "warn");
        return "已给出环境变量（Codex 仍可能读 .env 覆盖）";
      }

      if (actionId === "settings") {
        const { configureCursor, configureCodex, setQuiet } = await import("../cli.js");
        setQuiet(true);
        // Codex 的配置在 ~/.codex/.env，不是 settings.json
        const result =
          app.id === "codex" || app.name === "Codex"
            ? await configureCodex({
                proxyUrl: "http://127.0.0.1:8899",
                yes: true,
                quiet: true,
                app: findApp("codex"),
              })
            : await configureCursor({
                proxyUrl: "http://127.0.0.1:8899",
                yes: true,
                quiet: true,
                app: findApp(app.id) ?? app,
              });
        if (!result.ok) {
          setHint(
            app.name === "Codex"
              ? `写入失败：检查 ${app.name} 的 .env 写权限`
              : `写入失败：${app.name} 的配置文件可能还没生成，先打开一次应用`,
          );
          return null;
        }
        setHint(
          app.name === "Codex"
            ? "Codex 的 .env 已写入，新开一个终端跑 codex 就生效"
            : `${app.name} 配置已写入，重启应用后生效`,
        );
        return app.name === "Codex" ? "Codex 的代理已写入 .env" : `${app.name} 代理配置已写入`;
      }
      return null;
    },
    [launchApp, hint],
  );

  /** 第 3 步：真的发一个请求走一遍代理 */
  const runReach = useCallback(async () => {
    setExecuting("正在实测外网…");
    const result = await checkReachability({ port: state.sidecar.httpPort });
    setReach(result);
    setExecuting(null);
    log(
      result.ok ? `连通性正常 — ${result.detail}` : `连通性有问题 — ${result.detail}`,
      result.ok ? "ok" : "bad",
    );
  }, [state.sidecar.httpPort, log]);

  // 首次进入自动采集一次。
  useEffect(() => {
    refresh();
    markSeen();
  }, [refresh]);

  /** 规则列表（供删除使用） */
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
          ? `已保存 ${rule.value} · 重启转发服务后生效（按 S 两次）`
          : `${rule.value} 已经在规则里了`,
      );
    } catch (err) {
      setHint(`保存失败：${err.message}`);
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

    if (helpOpen) {
      if (key.escape || input === "h" || input === "?" || key.return) {
        setHelpOpen(false);
      }
      return;
    }

    if (input === "q") {
      exit();
      return;
    }
    // 手动加规则：任何一步都能加，不需要授权。
    if (input === "a") {
      setEditing("domain");
      setDraft("");
      setHint("");
      return;
    }
    if (input === "h" || input === "?") {
      setHelpOpen(true);
      return;
    }
    if (input === "r") {
      if (step === 3 && !done) {
        runReach();
      } else {
        refresh();
      }
      return;
    }
    if (input === "f") {
      runFix();
      return;
    }
    if (input === "S") {
      runService();
      return;
    }

    // ---- 向导：每一步只处理自己该处理的东西 --------------------------
    if (done) {
      if (key.return) {
        setDone(false);
        setStep(1);
        setStepResult(null);
        setReach(null);
      }
      return;
    }

    if (step === 1) {
      const installed = (state.apps ?? []).filter((a) => a.installed);
      if (key.upArrow) {
        setAppIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setAppIndex((i) => Math.min(Math.max(0, installed.length - 1), i + 1));
        return;
      }
      if (key.return) {
        const app = installed[appIndex];
        if (!app) {
          setHint("没检测到可用的工具，先装 Antigravity 或 Cursor");
          return;
        }
        setAppName(app.name);
        setAppId(app.id);
        // 列表已经按「这个应用能不能用」过滤过了，
        // 第一项就是能用的那种方式，光标落在它上面。
        setActionIndex(0);
        setStep(2);
        setHint("");
        // 进第 2 步就去看这个工具此刻的真实连接，别等用户问「到底生效没」
        refreshLive(app.id);
      }
      return;
    }

    if (step === 2) {
      if (key.escape) {
        setStep(1);
        setStepResult(null);
        return;
      }
      if (key.upArrow) {
        setActionIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        const total = actionsFor(appId).length;
        setActionIndex((i) => Math.min(Math.max(0, total - 1), i + 1));
        return;
      }
      if (key.return) {
        if (stepResult) {
          // 这一步做完了，等用户自己回车才进下一步
          setStepResult(null);
          setStep(3);
          setHint("");
          runReach();
          return;
        }
        if (!state.sidecar.running) {
          // 直接把这一步做完：先起服务，再接着启动应用。
          // 之前这里只启动服务就 return 了，用户按了回车却什么也没发生，
          // 看起来就是「根本不会自动拉起」。
          setBusy(true);
          setExecuting("正在启动转发服务…");
          runProxy()
            .then(async (started) => {
              if (!started) return;
              const app = findApp(appId) ?? { name: appName, id: appId };
              const action = actionsFor(appId)[actionIndex];
              if (!action) return;
              setExecuting(
                action.id === "settings"
                  ? `正在写入 ${appName} 的代理配置…`
                  : `正在以 tunless 代理重启 ${appName}…`,
              );
              const result = await applyAppAction(app, action.id);
              if (result) setStepResult(`✔ ${result}`);
              await refreshLive();
            })
            .catch((err) => setHint(`操作失败：${err.message}`))
            .finally(() => {
              setBusy(false);
              setExecuting(null);
            });
          return;
        }
        const app = findApp(appId) ?? { name: appName, id: appId };
        const action = actionsFor(appId)[actionIndex];
        if (!action) return;
        setBusy(true);
        const isCli = appId === "codex";
        setExecuting(
          isCli
            ? `正在写入 ${appName} 的 .env…`
            : action.id === "settings"
              ? `正在写入 ${appName} 的代理配置…`
              : `正在以 tunless 代理重启 ${appName}…`,
        );
        applyAppAction(app, action.id)
          .then(async (result) => {
            if (result) setStepResult(`✔ ${result}`);
            // 刚写完配置/重启过，立刻重新看真实连接
            await refreshLive();
          })
          .catch((err) => setHint(`操作失败：${err.message}`))
          .finally(() => {
            setBusy(false);
            setExecuting(null);
          });
      }
      return;
    }

    if (step === 3) {
      if (key.escape) {
        setStep(2);
        setReach(null);
        return;
      }
      if (key.return) {
        setStep(4);
        setHint("");
      }
      return;
    }

    if (step === 4) {
      if (key.escape) {
        setStep(3);
        return;
      }
      if (key.return) {
        setDone(true);
        setHint("");
      }
      if (input === "d") {
        deleteRule();
      }
    }
  });

  const width = stdout.columns || 80;
  const rows = stdout.rows || 24;

  let body;
  if (helpOpen) {
    body = h(HelpPanel, { width });
  } else if (done) {
    body = h(StepDone, { state, width, appName, reachability: reach });
  } else if (step === 1) {
    body = h(StepApps, { state, width, index: appIndex });
  } else if (step === 2) {
    body = h(StepLaunch, {
      state,
      width,
      index: actionIndex,
      appName,
      appId,
      result: stepResult,
      executing,
      live,
    });
  } else if (step === 3) {
    body = h(StepReach, { state, width, reachability: reach });
  } else {
    body = h(StepDomains, { state, width });
  }

  // 状态行放底部：用户看的是「我现在该按什么」，状态也该在那一带。

  const help = h(
    Text,
    { dimColor: true },
    hint || (helpOpen ? "Esc 返回" : "h 看用法 · a 手写内网域名 · r 刷新 · q 退出"),
  );

  return h(
    Box,
    { flexDirection: "column", height: rows },
    h(
      Box,
      { flexDirection: "row", justifyContent: "space-between" },
      h(Text, { color: theme.colors.accent, bold: true }, " tunless "),
      h(Text, { dimColor: true }, "给连不上外网的 agent 一个本地代理口，不用开 TUN"),
    ),
    h(
      Box,
      { flexDirection: "column", flexGrow: 1, overflow: "hidden" },
      body,
    ),
    h(StatusLine, {
      executing,
      progress: busy ? progress : null,
      updatedAt: state.updatedAt,
    }),
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
