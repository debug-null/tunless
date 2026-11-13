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
  StepUpstream,
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
  waitForMainPid,
  networkPid,
  processProxyEnv,
} from "../core/apps.js";
import { addRule, removeRule, saveRules, loadRules, RULE_KINDS } from "../core/rules.js";
import { markSeen } from "./first-run.js";
import { collectState, emptyState } from "./state.js";
import { startService, stopService } from "../core/launchd.js";
import { checkTargets } from "../core/reach.js";
import { resolveTargets, parseTarget, addCustomTarget } from "../core/targets.js";
import {
  verifyUpstream,
  probeProtocols,
  parseUpstream,
  savePinnedUpstream,
} from "../core/upstream.js";

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
  // 第 2 步：选哪个上游代理（探测出来的候选，或手动填）
  const [upstreamIndex, setUpstreamIndex] = useState(0);
  const [editingUpstream, setEditingUpstream] = useState(false);
  const [draftUpstream, setDraftUpstream] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [verifyResult, setVerifyResult] = useState(null);
  const [stepResult, setStepResult] = useState(null);
  // 第 3 步：连通性实测结果
  const [reach, setReach] = useState(null);
  // 手动加一个「要测的域名」，认不出来的工具/私有网关靠这个
  const [editingTarget, setEditingTarget] = useState(false);
  const [draftTarget, setDraftTarget] = useState("");
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
    const { cmdFix, setQuiet, takeCapturedOutput } = await import("../cli.js");
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
    // 失败时最要紧的是「为什么」。CLI 的原文攒在缓冲里，不取出来
    // 界面上就只剩一句没有信息量的「修复未完成」。
    const detail = takeCapturedOutput();
    if (code === 0) {
      log("修复完成", "ok");
    } else {
      const reason =
        detail
          .split("\n")
          .map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trim())
          .filter((line) => line && !/^──.*──$/.test(line))
          .slice(-3)
          .join(" ") || "没有拿到具体原因";
      log(`修复未完成：${reason}`, "warn");
      setHint(`修复未完成：${reason}`);
    }
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
      const { cmdLaunch, setQuiet, takeCapturedOutput } = await import("../cli.js");
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
      // 静默模式下 CLI 的输出被攒着。失败时这是唯一能说明原因的东西，
      // 必须取出来展示，否则界面上只剩一句「没能启动」。
      const detail = takeCapturedOutput();
      // 界面上的状态行只留一两行，真正的原因必须落到文件里 ——
      // 否则用户只能看到「没能启动」，我们永远查不出为什么。
      try {
        const fs = await import("node:fs");
        const path = await import("node:path");
        const os = await import("node:os");
        const dir = path.join(os.homedir(), ".tunless");
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(
          path.join(dir, "tui.log"),
          `\n[${new Date().toISOString()}] launch ${app} exit=${code}\n${detail}\n`,
          "utf8",
        );
      } catch {
        // 记日志失败不该影响主流程
      }
      if (code !== 0) {
        const reason =
          detail
            .split("\n")
            .map((line) => line.replace(/^\s*[•✔✖▲]\s*/, "").trim())
            .filter(Boolean)
            .slice(-3)
            .join("；") || `退出码 ${code}`;
        log(`${app} 启动失败：${reason}`, "bad");
        await refresh();
        return { ok: false, code, detail };
      }

      // 不要只相信「命令跑完没报错」。真的去看进程在不在 ——
      // 之前 open 失败被吞掉，界面照样说「已重启」，用户看到的就是
      // 「根本没自动拉起」。
      //
      // 但也不能马上看：open -a 返回只是「收到请求」，Electron 进程
      // 还要几百毫秒到几秒才出现。不等就会把「正在启动」判成「没起来」。
      const target = findApp(app);
      const alive = target ? await waitForMainPid(target) : null;
      if (!alive) {
        log(`${app} 在 15 秒内没有启动起来`, "bad");
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
          // 把 CLI 说的原因原样带出来，别让用户只看到一句「没能启动」。
          const detail = launched?.detail
            ?.split("\n")
            .map((line) => line.replace(/^\s*[•✔✖▲]\s*/, "").trim())
            .filter(Boolean)
            .slice(-2)
            .join("；");
          setHint(
            app.id === "codex" || app.name === "Codex"
              ? "写入 .env 失败，检查一下文件权限"
              : detail
                ? `${app.name} 没能启动：${detail}`
                : `${app.name} 没能启动。用 tunless launch ${app.name} 看详细报错`,
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

  /**
   * 第 3 步：按这个工具**自己会连的域名**测，而不是固定测 github。
   * Antigravity 报的是 oauth2.googleapis.com 超时，测 github 通不通没有意义。
   */
  const runReach = useCallback(async () => {
    setExecuting("正在实测外网…");
    const targets = resolveTargets(appId ?? appName);
    const result = await checkTargets({ port: state.sidecar.httpPort, targets });
    setReach(result);
    setExecuting(null);
    const okCount = result.results.filter((r) => r.ok).length;
    log(
      result.ok
        ? `连通性正常 — ${okCount}/${result.results.length} 个目标可达`
        : `连通性有问题 — ${result.failedRequired.length} 个必需目标不通`,
      result.ok ? "ok" : "bad",
    );
  }, [state.sidecar.httpPort, appId, appName, log]);

  /**
   * 选定上游代理后，验证它真的能出网，再进入下一步。
   *
   * 只「端口在监听」不够 —— 端口可能是别的服务，或者代理本身连不上节点。
   * 验证结果写成 state.upstream.chosen，启动那一步和界面都读它。
   */
  const adoptUpstream = useCallback(
    async (candidate) => {
      const upstream = {
        host: candidate.host,
        port: candidate.port,
        protocols: candidate.protocols ?? ["http", "socks5"],
      };
      setVerifying(true);
      setVerifyResult(null);
      setState((prev) => ({
        ...prev,
        upstream: {
          ...prev.upstream,
          chosen: upstream,
          detail: `${candidate.label ?? "手动选择"} · ${(candidate.protocols ?? []).join("+") || "未知协议"}`,
        },
      }));

      const check = await verifyUpstream(upstream).catch((err) => ({
        ok: false,
        detail: err.message,
      }));
      setVerifying(false);
      setVerifyResult({ ...check, upstream });

      if (!check.ok) {
        log(`${candidate.host}:${candidate.port} 出不了网 — ${check.detail}`, "bad");
        setHint(
          `这个端口像是代理，但连不上外网（${check.detail}）。可以换一个，或按 m 手动填`,
        );
        return;
      }

      // 真正生效要落盘：常驻服务是 launchd 拉起来的，拿不到当前界面的选择。
      try {
        savePinnedUpstream({ host: upstream.host, port: upstream.port });
        log(`上游代理已固定为 ${upstream.host}:${upstream.port}`, "ok");
      } catch (err) {
        log(`保存上游代理失败：${err.message}`, "warn");
      }

      // 已经在跑的服务还连着旧端口。不重启的话，下一步「启动应用」看起来
      // 一切正常，但流量仍然从旧上游出去 —— 用户改了设置却没生效。
      if (state.sidecar.installed) {
        setExecuting("正在让转发服务改用新上游…");
        try {
          const { restartService } = await import("../core/launchd.js");
          await restartService();
          log("转发服务已重启，改用新的上游", "ok");
        } catch (err) {
          log(`重启转发服务失败：${err.message}`, "warn");
          setHint(`上游已保存，但转发服务没重启成功：${err.message}`);
        } finally {
          setExecuting(null);
        }
      }

      setStep(3);
      setHint("");
      setActionIndex(0);
      log(`上游代理：${upstream.host}:${upstream.port} — 能出网`, "ok");
      refreshLive(appId);
    },
    [appId, log, refreshLive, state.sidecar.installed],
  );

  /** 手动填写上游端口：先探测协议，再走同一套验证 */
  const confirmUpstream = useCallback(
    async (raw) => {
      const parsed = parseUpstream(raw);
      if (!parsed) {
        setHint("格式不对，应该是 127.0.0.1:7897 这样");
        return;
      }
      const protocols = await probeProtocols(parsed.host, parsed.port).catch(() => []);
      if (!protocols.length) {
        setVerifyResult({
          ok: false,
          detail: `${parsed.host}:${parsed.port} 上没有认出代理协议`,
        });
        setHint("这个端口不像代理。TUN 模式下的端口可能只对系统可见，换个端口试试");
        return;
      }
      setEditingUpstream(false);
      setDraftUpstream("");
      await adoptUpstream({ ...parsed, protocols, label: "手动填写" });
    },
    [adoptUpstream],
  );

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
    // 输入自定义测试目标
    if (editingTarget) {
      if (key.escape) {
        setEditingTarget(false);
        setDraftTarget("");
        return;
      }
      if (key.return) {
        const parsed = parseTarget(draftTarget);
        if (!parsed) {
          setHint("看不懂这个地址，试试 api.example.com 或 api.example.com:8443/path");
          return;
        }
        const { added } = addCustomTarget(parsed);
        setEditingTarget(false);
        setDraftTarget("");
        setHint(
          added
            ? `已添加 ${parsed.host}，重新测一次看结果`
            : `${parsed.host} 已经在列表里了`,
        );
        setTimeout(runReach, 0);
        return;
      }
      if (key.backspace || key.delete) {
        setDraftTarget((v) => v.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setDraftTarget((v) => v + input);
      }
      return;
    }

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
      if (step === 4 && !done) {
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
        // 探测出来的第一个候选就是默认选中项，用户直接回车即可
        setUpstreamIndex(0);
        setVerifyResult(null);
      }
      return;
    }

    if (step === 2) {
      // ---- 选上游代理：先确定「代理谁」，再谈怎么启动 ----------------
      if (editingUpstream) {
        if (key.escape) {
          setEditingUpstream(false);
          setDraftUpstream("");
          setVerifyResult(null);
          return;
        }
        if (key.return) {
          confirmUpstream(draftUpstream);
          return;
        }
        if (key.backspace || key.delete) {
          setDraftUpstream((v) => v.slice(0, -1));
          return;
        }
        if (input && !key.ctrl && !key.meta) {
          setDraftUpstream((v) => v + input);
        }
        return;
      }
      if (key.escape) {
        setStep(1);
        setVerifyResult(null);
        return;
      }
      if (input === "m") {
        setEditingUpstream(true);
        setDraftUpstream(
          state.upstream?.chosen
            ? `${state.upstream.chosen.host}:${state.upstream.chosen.port}`
            : "127.0.0.1:",
        );
        setVerifyResult(null);
        return;
      }
      const candidates = state.upstream?.candidates ?? [];
      if (key.upArrow) {
        setUpstreamIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setUpstreamIndex((i) => Math.min(Math.max(0, candidates.length - 1), i + 1));
        return;
      }
      if (key.return) {
        const chosen = candidates[upstreamIndex];
        if (!chosen) {
          // 一个都没探到：直接进手动填写，而不是让用户卡在这
          setEditingUpstream(true);
          setDraftUpstream("127.0.0.1:");
          setHint("没探测到代理，手动填一个端口");
          return;
        }
        adoptUpstream(chosen);
        return;
      }
      return;
    }

    if (step === 3) {
      if (key.escape) {
        setStep(2);
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
          setStep(4);
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

    if (step === 4) {
      if (input === "t") {
        setEditingTarget(true);
        setDraftTarget("");
        setHint("");
        return;
      }
      if (key.escape) {
        setStep(3);
        setReach(null);
        return;
      }
      if (key.return) {
        setStep(5);
        setHint("");
      }
      return;
    }

    if (step === 5) {
      if (key.escape) {
        setStep(4);
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
    body = h(StepUpstream, {
      state,
      width,
      index: upstreamIndex,
      pinned: state.upstream?.pinned,
      editing: editingUpstream,
      draft: draftUpstream,
      verifying,
      verifyResult,
    });
  } else if (step === 3) {
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
  } else if (step === 4) {
    body = h(StepReach, {
      state,
      width,
      reachability: reach,
      appName,
      editingTarget,
      draftTarget,
    });
  } else {
    body = h(StepDomains, { state, width });
  }

  // 状态行放底部：用户看的是「我现在该按什么」，状态也该在那一带。

  const help = h(
    Text,
    { dimColor: true },
    hint ||
      (editingTarget
        ? "回车保存 · Esc 取消"
        : editingUpstream
          ? "回车确认 · Esc 取消"
          : step === 2 && !done
            ? "↑↓ 选代理 · 回车确认 · m 手动填 · q 退出"
            : step === 4 && !done
              ? "r 重测 · t 加一个要测的域名 · 回车下一步"
              : helpOpen
                ? "Esc 返回"
                : "h 看用法 · a 手写内网域名 · r 刷新 · q 退出"),
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
