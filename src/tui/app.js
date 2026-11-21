// TUI 主程序：基于 ink 的图形界面。
//
// 结构是「仪表盘为家 + 按键钻取」：平时停在一屏四行的仪表盘上，
// 按 g 进五步向导（选工具 → 选上游 → 用代理启动 → 测连通 → 内网域名），
// 走完回车回家，第 1 步按 Esc 也回家。
//
// 主题：启动时用 OSC 11 询问终端背景色，按亮暗切换配色；
// 终端不支持 Unicode 时符号与边框降级成 ASCII。

import "../color-env.js";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { render, Box, Text, useApp, useInput, useStdout, useWindowSize } from "ink";
import { h, ThemeProvider, useTheme } from "./ui.js";
import { getTheme, detectUnicode } from "./theme.js";
import { queryTerminalColorScheme, themeFromEnv } from "./terminal-theme.js";
import {
  StepApps,
  StepUpstream,
  StepLaunch,
  StepReach,
  StepDomains,
  StepDone,
  StatusLine,
} from "./steps.js";
import { HelpPanel } from "./help.js";
import { Dashboard } from "./screens/dashboard.js";
import { Workbench } from "./screens/workbench.js";
import { ServiceScreen } from "./screens/service.js";
import { DomainsScreen } from "./screens/domains.js";
import { UpstreamScreen } from "./screens/upstream.js";
import { KeyBar } from "./components/key-bar.js";
import { EventFeed } from "./components/event-feed.js";
import { actionsFor } from "./app-menu.js";
import {
  findApp,
  appProxyPorts,
  proxyVerdict,
  waitForMainPid,
  networkPid,
  processProxyEnv,
} from "../core/apps.js";
import { addRule, removeRule, saveRules, loadRules, RULE_KINDS } from "../core/rules.js";
import { markSeen } from "./first-run.js";
import { collectState, emptyState } from "./state.js";
import { startService, stopService, restartService } from "../core/launchd.js";
import { checkTargets } from "../core/reach.js";
import { resolveTargets, parseTarget, addCustomTarget } from "../core/targets.js";
import {
  verifyUpstream,
  probeProtocols,
  parseUpstream,
  savePinnedUpstream,
  systemProxyPortsFromState,
} from "../core/upstream.js";
import { overviewLines, rowsFor, verdictFor } from "../core/status-rows.js";
import { createReporter } from "../cli/report.js";

export function App({ internalDns, repoRoots = [], includeChrome = false }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const windowSize = useWindowSize();
  const theme = useTheme();

  const [state, setState] = useState(emptyState);
  // 屏幕路由：dashboard 是家，wizard 是五步向导，
  // service/upstream/domains 是钻取屏。
  const [screen, setScreen] = useState("dashboard");
  // 服务与日志屏的事件回看偏移：0 贴最新，↑ 往回翻
  const [eventScroll, setEventScroll] = useState(0);
  // 向导内部状态：wizardStep 是当前第几步，wizardDone 是收尾页。
  const [wizardStep, setWizardStep] = useState(1);
  const [wizardDone, setWizardDone] = useState(false);
  // 第 1 步选中的应用
  const [appIndex, setAppIndex] = useState(0);
  const [appName, setAppName] = useState(null);
  const [appId, setAppId] = useState(null);
  // 第 2 步：选中的处理方式 + 执行结果
  const [actionIndex, setActionIndex] = useState(0);
  const [writeArmed, setWriteArmed] = useState(false);
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
    // 判定的基准是转发服务实际监听的端口，不是写死的 8899 ——
    // 用户自定义端口时，按 8899 判会永远报「没走代理」。
    const tunlessPort = state.sidecar?.httpPort ?? 8899;
    try {
      const conn = await appProxyPorts(target);
      // 光有连接还不够：得看联网子进程的环境里到底有没有代理。
      // 没有的话它会去直连真实 IP，报 `dial tcp … i/o timeout`，
      // 而界面还显示「已走 8899」，完全是误导。
      const netPid = await networkPid(target);
      const env = await processProxyEnv(netPid, tunlessPort);
      const next = {
        ...conn,
        verdict: conn.error
          ? { state: "probe-error", ports: conn.ports }
          : proxyVerdict(conn, tunlessPort),
        netPid,
        env,
      };
      setLive(next);
      return next;
    } catch {
      setLive(null);
      return null;
    }
  }, [appId, state.sidecar?.httpPort]);

  const refreshAbort = useRef(null);
  const refresh = useCallback(async () => {
    if (refreshAbort.current) {
      refreshAbort.current.abort();
      setState((prev) => ({ ...prev, loading: false }));
      setBusy(false);
      setProgress("");
      setHint("检测已取消。等这一轮网络探测停下后再按 r");
      return null;
    }
    const ac = new AbortController();
    refreshAbort.current = ac;
    setBusy(true);
    setProgress("正在采集…");
    try {
      const next = await collectState({
        internalDns,
        repoRoots,
        includeChrome,
        signal: ac.signal,
        onProgress: (stage, partial) => {
          if (ac.signal.aborted) return;
          setProgress(stage);
          setState((prev) => ({ ...prev, ...partial, loading: true }));
        },
      });
      if (ac.signal.aborted) {
        setState((prev) => ({ ...prev, loading: false }));
        return null;
      }
      setState(next);
      await refreshLive();
      log(`状态已更新（内网域名 ${next.internalDomains.length} 个）`, "ok");
      return next;
    } catch (err) {
      setState((prev) => ({ ...prev, loading: false }));
      if (ac.signal.aborted || err.name === "AbortError") {
        setHint("检测已取消");
        return null;
      }
      log(`刷新失败：${err.message}。按 r 重试`, "bad");
      setHint(`刷新失败：${err.message}。按 r 重试`);
      return null;
    } finally {
      if (refreshAbort.current === ac) refreshAbort.current = null;
      setBusy(false);
      setProgress("");
    }
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
      // 转发服务停着就把应用重启成走 :8899，等于亲手断网 —— 先把它拉起来。
      // 放这一层而不是调用方：工作台回车和向导第 3 步共用同一份保护。
      if (!state.sidecar.running) {
        setExecuting("转发服务没在跑，先启动它…");
        try {
          if (!state.sidecar.installed) {
            const { cmdService, setQuiet } = await import("../cli.js");
            setQuiet(true);
            await cmdService({ _: ["service", "install"] }, { quiet: true });
          } else {
            await startService();
          }
          await refresh();
          log("转发服务已启动", "ok");
        } catch (err) {
          setHint(`转发服务起不来：${err.message}，先解决它再配应用`);
          log(`转发服务启动失败：${err.message}`, "bad");
          return null;
        }
      }
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
    [launchApp, hint, state.sidecar.running, state.sidecar.installed, log, refresh],
  );

  /**
   * 第 3 步：按这个工具**自己会连的域名**测，而不是固定测 github。
   * Antigravity 报的是 oauth2.googleapis.com 超时，测 github 通不通没有意义。
   */
  const runReach = useCallback(async (forApp = null) => {
    setExecuting("正在实测外网…");
    const targets = resolveTargets(forApp ?? appId ?? appName);
    const result = await checkTargets({ port: state.sidecar.httpPort, targets });
    setReach(result);
    setExecuting(null);
    const okCount = result.results.filter((r) => r.ok).length;
    log(
      result.serviceVerified
        ? `服务调用已通过 — ${okCount}/${result.results.length}`
        : result.ok
          ? `隧道到达 ${okCount}/${result.results.length}，服务未验证`
          : `隧道未建立 — ${result.failedRequired.length} 个必需目标不通`,
      result.serviceVerified ? "ok" : result.ok ? "warn" : "bad",
    );
    return result;
  }, [state.sidecar.httpPort, appId, appName, log]);

  /**
   * 选定上游代理后，验证它真的能出网，再进入下一步。
   *
   * 只「端口在监听」不够 —— 端口可能是别的服务，或者代理本身连不上节点。
   * 验证结果写成 state.upstream.chosen，启动那一步和界面都读它。
   */
  const adoptUpstream = useCallback(
    async (candidate) => {
      if (candidate.authRequired?.length && !candidate.protocols?.length) {
        log(`${candidate.host}:${candidate.port} 需要认证（${candidate.authRequired.join("+")}），当前不代填凭据`, "warn");
        setHint("这个端口要认证。本轮不会把它当成可用上游");
        return;
      }
      const upstream = {
        host: candidate.host,
        port: candidate.port,
        protocols: candidate.protocols ?? [],
      };
      if (!upstream.protocols.length) {
        log(`${candidate.host}:${candidate.port} 没有免认证的 HTTP/SOCKS`, "bad");
        return;
      }
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
        // 记下此刻系统代理的端口：以后系统代理变了，能分清
        // 「用户换了客户端」还是「用户自己又选回了这个端口」。
        const systemProxyPorts = systemProxyPortsFromState(state.systemProxy);
        savePinnedUpstream({
          host: upstream.host,
          port: upstream.port,
          systemProxyPorts,
          systemProxyPort: systemProxyPorts[0] ?? null,
        });
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

      // 钻取屏没有「下一步」可进：固定完就回家，结果放 hint 让人看到；
      // 向导里照旧推进到第 3 步。
      if (screen === "upstream") {
        setScreen("dashboard");
        setHint(`上游已固定 ${upstream.host}:${upstream.port}`);
      } else {
        setWizardStep(3);
        setHint("");
      }
      setActionIndex(0);
      log(`上游代理：${upstream.host}:${upstream.port} — 能出网`, "ok");
      refreshLive(appId);
    },
    [appId, log, refreshLive, screen, state.sidecar.installed],
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

  // 初始化只该跑一次。但 refresh 的身份跟着 refreshLive → appId 变，
  // 依赖它写 [refresh] 等于「每次选完应用再全量采集一遍」——
  // 把回调放进 ref，挂载效果只认 ref。
  const appIdRef = useRef(null);
  const latest = useRef({});
  // 停服二次确认的时间戳：第一次按只提示，4 秒内再按才真停。
  const stopConfirmAt = useRef(0);
  // 实测没过等着「再按一次回车重启修复」的 app.id
  const [pendingFix, setPendingFix] = useState(null);
  useEffect(() => {
    appIdRef.current = appId;
    latest.current = { refresh, runReach, refreshLive, log };
  });

  // 首次进入自动采集一次。什么都没配过（服务没装、上游没选也没固定）
  // 就直接进向导带着走一遍；其余情况永远落仪表盘 —— 它是家。
  useEffect(() => {
    Promise.resolve(latest.current.refresh?.()).then((next) => {
      // 采集要好几秒，用户可能已经先动手了 —— 别把人拽走。
      if (!next || appIdRef.current) return;
      if (!next.upstream?.pinned && !next.sidecar?.installed && !next.upstream?.chosen) {
        setScreen("wizard");
        latest.current.log?.("看起来是第一次配置，进向导", "info");
      }
    });
    markSeen();
  }, []);

  /** 规则列表（供删除使用） */
  const flatRules = useCallback(() => {
    const rules = state.rules ?? { domain: [], keyword: [], cidr: [] };
    return RULE_KINDS.flatMap((kind) => (rules[kind] ?? []).map((value) => ({ kind, value })));
  }, [state.rules]);

  /**
   * 规则变了，跑着的转发服务还在用旧路由 —— 让它重启立刻生效，
   * 而不是提示用户自己「按 S 两次」。
   */
  const restartSidecarForRules = useCallback(async () => {
    if (!state.sidecar?.running) return;
    try {
      const st = await restartService();
      log(st.running ? "转发服务已重启，规则已生效" : "转发服务没起来，按 S 手动启动",
        st.running ? "ok" : "warn");
    } catch (err) {
      log(`重启转发服务失败：${err.message}`, "warn");
    }
  }, [state.sidecar?.running, log]);

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
          ? state.sidecar?.running
            ? `已保存 ${rule.value} · 正在重启转发服务让它生效`
            : `已保存 ${rule.value} · 下次启动转发服务时生效`
          : `${rule.value} 已经在规则里了`,
      );
      if (added) restartSidecarForRules();
    } catch (err) {
      setHint(`保存失败：${err.message}`);
      return;
    }
    setEditing(null);
    setDraft("");
  }, [draft, editing, log, state.sidecar?.running, restartSidecarForRules]);

  const deleteRule = useCallback(() => {
    const list = flatRules();
    if (!list.length) {
      setHint("还没有手动规则可删");
      // domains 屏上看不到 hint 行，落一条事件让按键有回响
      log("还没有手动规则可删", "warn");
      return;
    }
    // 与 domains 屏光标同一个 clamp：ruleIndex 陈旧（外部改了规则文件）时
    // 高亮哪条删哪条，不能用 % 绕回删到别的规则。
    const target = list[Math.min(Math.max(0, ruleIndex), list.length - 1)];
    try {
      const { rules, removed } = removeRule(loadRules(), target.value, target.kind);
      saveRules(rules);
      setState((prev) => ({ ...prev, rules }));
      log(removed ? `已删除规则：${target.value}` : `没有这条规则：${target.value}`, removed ? "warn" : "bad");
      setHint(removed ? `已删除 ${target.value}` : `没有找到 ${target.value}`);
      setRuleIndex(0);
      if (removed) restartSidecarForRules();
    } catch (err) {
      setHint(`删除失败：${err.message}`);
    }
  }, [flatRules, ruleIndex, log, restartSidecarForRules]);

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

    // 手动填写上游端口：所有按键进输入框（原本住在向导第 2 步里，
    // 提到这层守卫后，将来的上游屏也能复用同一套输入逻辑）。
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

    if (helpOpen) {
      if (key.escape || input === "h" || input === "?" || key.return) {
        setHelpOpen(false);
      }
      return;
    }

    // 原始模式里 Ctrl+D 只是字符 \x04，不是操作系统的 EOF。
    // 把它当成退出，避免用户按了没反应。
    if (key.ctrl && input === "d") {
      exit();
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
      if (screen === "wizard" && wizardStep === 4 && !wizardDone) {
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
    if (input === "s" || input === "S" || input === " ") {
      // 停服 = 断掉所有已代理工具的网，误触一次代价太大 —— 要停就在
      // 4 秒内再按一次确认；启动没有副作用，保持一键。
      if (state.sidecar.running && Date.now() - stopConfirmAt.current > 4000) {
        stopConfirmAt.current = Date.now();
        setHint("再按一次空格/S 确认停止转发服务（所有代理工具会断网）");
        return;
      }
      stopConfirmAt.current = 0;
      runService();
      return;
    }

    // ---- 极简工作台：↑↓ 在已安装 AI 工具间移动，回车一键生效/测速，u/d 直通两屏 ----
    if (screen === "dashboard") {
      const apps = (state.apps ?? []).filter((a) => a.installed === true);

      if (input === "c") {
        const app = apps[Math.min(appIndex, Math.max(0, apps.length - 1))];
        if (!app) {
          setHint("没有可配置的已安装工具");
          return;
        }
        setAppId(app.id);
        setAppName(app.name);
        setActionIndex(0);
        setWriteArmed(false);
        setScreen("wizard");
        setWizardStep(3);
        setWizardDone(false);
        setStepResult(null);
        setHint("配置不会自动写入。选中会改文件的项后回车，再按 y 确认");
        return;
      }
      if (input === "g") {
        setScreen("wizard");
        setWizardStep(1);
        setWizardDone(false);
        setStepResult(null);
        setReach(null);
        setHint("");
        return;
      }
      if (input === "d") {
        setScreen("domains");
        setHint("");
        return;
      }
      if (input === "l") {
        setEventScroll(0);
        setScreen("service");
        setHint("");
        return;
      }
      if (input === "u") {
        setScreen("upstream");
        setUpstreamIndex(0);
        setVerifyResult(null);
        setHint("");
        return;
      }
      if (key.return) {
        const app = apps[Math.min(appIndex, Math.max(0, apps.length - 1))];
        if (!app) {
          setHint("没有已安装的工具，回车不会改配置。按 q 退出");
          return;
        }
        // 动作在跑时回车不能再起一个 —— launchApp 是真副作用（quit + open）。
        if (executing || busy) {
          setHint("检测还在跑。再按 r 取消");
          return;
        }

        if (!state.sidecar?.running) {
          setHint("转发服务没在听。按空格启动后再回车测隧道。这一步不改配置");
          return;
        }
        setHint("");
        runReach(app.id).then((r) => {
          if (!r) return;
          const codes = r.results.map((x) => x.httpStatus).filter((n) => Number.isFinite(n));
          setState((prev) => ({ ...prev, reach: r }));
          setHint(
            r.serviceVerified
              ? `${app.name} 模型调用已验证`
              : r.ok
                ? `${app.name} 隧道到达${codes.length ? ` HTTP ${codes.join("/")}` : ""}，模型未验证`
                : `${app.name} 隧道没建立。模型仍是未验证，按 c 看配置`,
          );
        });
        return;
      }
      if (key.upArrow || input === "k") {
        setAppIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setAppIndex((i) => Math.min(Math.max(0, apps.length - 1), i + 1));
        return;
      }
      return;
    }

    // ---- 服务与日志屏：↑↓ 翻事件历史；s 启停是全局键不重复接 ----------
    if (screen === "service") {
      if (key.escape) {
        setScreen("dashboard");
        return;
      }
      if (key.upArrow || input === "k") {
        // 滚到「最早一窗」就停：再往上窗口越削越薄，没有更早的可看。
        // limit 与 ServiceScreen 内同一个公式（rows - 14）。
        const limit = Math.max(5, (windowSize.rows || 24) - 14);
        setEventScroll((n) => Math.min(Math.max(0, events.length - limit), n + 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setEventScroll((n) => Math.max(0, n - 1));
        return;
      }
      return;
    }

    // ---- 域名与规则屏：↑↓ 选手写规则，d 删；a 加规则是全局键不重复接 ----
    if (screen === "domains") {
      if (key.escape) {
        setScreen("dashboard");
        return;
      }
      if (input === "d") {
        deleteRule();
        return;
      }
      const total = flatRules().length;
      if (key.upArrow || input === "k") {
        setRuleIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setRuleIndex((i) => Math.min(Math.max(0, total - 1), i + 1));
        return;
      }
      return;
    }

    // ---- 上游屏：候选里选一个回车验证固定；m 手填走顶部输入守卫 --------
    if (screen === "upstream") {
      if (key.escape) {
        setScreen("dashboard");
        return;
      }
      if (input === "m") {
        // 与向导第 2 步同一个 m 分支：有选中的就预填，没有给本地前缀
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
      if (key.upArrow || input === "k") {
        setUpstreamIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow || input === "j") {
        setUpstreamIndex((i) => Math.min(Math.max(0, candidates.length - 1), i + 1));
        return;
      }
      if (key.return) {
        const chosen =
          candidates[Math.min(upstreamIndex, Math.max(0, candidates.length - 1))];
        if (!chosen) {
          // 一个都没探到：直接进手动填写，跟向导第 2 步同一个空态分支
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

    // ---- 向导：每一步只处理自己该处理的东西 --------------------------
    if (screen !== "wizard") return; // 还没有的屏：按键一律不响应
    if (wizardDone) {
      if (key.return) {
        // 向导已经完成使命：回仪表盘，不再原地重开。
        setScreen("dashboard");
        setWizardDone(false);
      }
      return;
    }

    if (wizardStep === 1) {
      const installed = (state.apps ?? []).filter((a) => a.installed);
      if (key.escape) {
        // 现在有家可回：第 1 步 Esc 直接回仪表盘
        setScreen("dashboard");
        return;
      }
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
        // live 连接探测按 appId 走 —— 换工具了就重看一眼，别拿上一个
        // 应用的连接状态说事。
        refreshLive(app.id);
        // 列表已经按「这个应用能不能用」过滤过了，
        // 第一项就是能用的那种方式，光标落在它上面。
        setActionIndex(0);
        setWizardStep(2);
        setHint("");
        // 探测出来的第一个候选就是默认选中项，用户直接回车即可
        setUpstreamIndex(0);
        setVerifyResult(null);
      }
      return;
    }

    if (wizardStep === 2) {
      // ---- 选上游代理：先确定「代理谁」，再谈怎么启动 ----------------
      if (key.escape) {
        setWizardStep(1);
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

    if (wizardStep === 3) {
      const writesFiles = (id) => id === "settings" || id === "env+settings";
      if (key.escape) {
        setWriteArmed(false);
        setWizardStep(2);
        setStepResult(null);
        return;
      }
      const confirmNow = writeArmed && input === "y";
      if (writeArmed && !confirmNow) {
        setWriteArmed(false);
        if (key.upArrow) {
          setActionIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (key.downArrow) {
          const total = actionsFor(appId).length;
          setActionIndex((i) => Math.min(Math.max(0, total - 1), i + 1));
          return;
        }
        setHint("已取消写入。方向键另选，或 Esc 返回");
        return;
      }
      if (confirmNow) setWriteArmed(false);
      if (!writeArmed) {
        if (key.upArrow) {
          setActionIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (key.downArrow) {
          const total = actionsFor(appId).length;
          setActionIndex((i) => Math.min(Math.max(0, total - 1), i + 1));
          return;
        }
      }
      if (key.return || confirmNow) {
        // 动作在跑时回车不能再起一个 —— 与 apps 屏同一个守卫。
        if (executing || busy) return;
        if (stepResult) {
          // 这一步做完了，等用户自己回车才进下一步
          setStepResult(null);
          setWizardStep(4);
          setHint("");
          runReach();
          return;
        }
        const pending = actionsFor(appId)[actionIndex];
        if (pending && writesFiles(pending.id) && !confirmNow) {
          setWriteArmed(true);
          setHint(`将写入 ${appName} 的配置文件。按 y 确认，其它键取消`);
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

    if (wizardStep === 4) {
      if (input === "t") {
        setEditingTarget(true);
        setDraftTarget("");
        setHint("");
        return;
      }
      if (key.escape) {
        setWizardStep(3);
        setReach(null);
        return;
      }
      if (key.return) {
        setWizardStep(5);
        setHint("");
      }
      return;
    }

    if (wizardStep === 5) {
      if (key.escape) {
        setWizardStep(4);
        return;
      }
      if (key.return) {
        setWizardDone(true);
        setHint("");
      }
      if (input === "d") {
        deleteRule();
      }
    }
  });

  const width = windowSize.columns || stdout.columns || 80;
  const rows = windowSize.rows || stdout.rows || 24;
  const cramped = width < 60 || rows < 18;

  let body;
  if (helpOpen) {
    body = h(HelpPanel, { width, rows });
  } else if (screen === "dashboard") {
    body = h(Workbench, { state, appIndex, hint, executing, width });
  } else if (screen === "upstream") {
    body = h(UpstreamScreen, {
      state,
      width,
      index: upstreamIndex,
      pinned: state.upstream?.pinned,
      editing: editingUpstream,
      draft: draftUpstream,
      verifying,
      verifyResult,
      embedded: false,
    });
  } else if (screen === "service") {
    body = h(ServiceScreen, { state, width, events, eventScroll, rows });
  } else if (screen === "domains") {
    body = h(DomainsScreen, { state, width, ruleIndex, rules: flatRules() });
  } else if (wizardDone) {
    body = h(StepDone, { state, width, appName, reachability: reach });
  } else if (wizardStep === 1) {
    body = h(StepApps, { state, width, index: appIndex });
  } else if (wizardStep === 2) {
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
  } else if (wizardStep === 3) {
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
  } else if (wizardStep === 4) {
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
        : editing
          ? "Tab 换类型 · 回车保存 · Esc 取消"
          : editingUpstream
            ? "回车确认 · Esc 取消"
            : helpOpen
              ? "Esc 返回"
              : wizardStep === 2 && !wizardDone
                ? "↑↓ 选代理 · 回车确认 · m 手动填 · q 退出"
                : wizardStep === 4 && !wizardDone
                  ? "r 重测 · t 加一个要测的域名 · 回车下一步"
                  : "h 看用法 · a 手写内网域名 · r 刷新 · q 退出"),
  );

  // 最近几条事件走 EventFeed 组件。仪表盘/服务屏自己在正文里就带了事件流，
  // 底部再给其余屏（向导/域名/上游/工具）留一份；各屏底栏换成自己的 KeyBar，
  // hint（修复/启停的结果）有值时在 KeyBar 上方露一行，别只进事件流。
  // 帮助打开或正在输入时始终走 help 文案 —— HelpPanel 自己不写「Esc 返回」。
  const idle = !helpOpen && !editing && !editingTarget && !editingUpstream;
  const footer =
    screen === "dashboard" && idle
      ? h(KeyBar, { keys: DASHBOARD_KEYS })
      : screen === "upstream" && idle
        ? h(KeyBar, { keys: UPSTREAM_KEYS })
        : screen === "service" && idle
          ? h(KeyBar, { keys: SERVICE_KEYS })
          : screen === "domains" && idle
            ? h(KeyBar, { keys: DOMAINS_KEYS })
            : help;

  if (cramped && !editing && !editingTarget && !editingUpstream) {
    const brief = overviewLines(state).slice(0, Math.max(1, rows - 4));
    return h(
      Box,
      { flexDirection: "column", height: rows, overflow: "hidden" },
      brief.map((row) =>
        h(
          Text,
          { key: row.id },
          `${row.label} ${row.detail}`.slice(0, Math.max(8, width)),
        ),
      ),
      h(
        Text,
        null,
        `窗口 ${width}x${rows} 太小。至少 60 列、18 行。q 退出`.slice(0, Math.max(8, width)),
      ),
      hint
        ? h(Text, null, hint.slice(0, Math.max(8, width)))
        : h(Text, null, "q 退出"),
    );
  }

  return h(
    Box,
    { flexDirection: "column", height: rows, overflow: "hidden" },
    screen === "dashboard"
      ? null
      : h(
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
    screen === "dashboard"
      ? null
      : h(StatusLine, {
          executing,
          progress: busy ? progress : null,
          updatedAt: state.updatedAt,
        }),
    h(
      Box,
      { flexDirection: "column" },
      screen === "dashboard" || screen === "service"
        ? (screen !== "dashboard" && hint)
          ? h(Text, { dimColor: true }, ` ${hint}`)
          : null
        : h(EventFeed, { events, limit: 3 }),
      // 规则输入态必须可见 —— 之前 RulesPanel 不在组件树里时按 a
      // 会进一个没有界面的模态，按键全被吞掉像假死。
      editing
        ? h(
            Text,
            null,
            h(Text, { dimColor: true }, `  内网规则 [${editing}] `),
            h(Text, { color: theme.colors.accent }, draft),
            h(Text, { color: theme.colors.accent }, "█"),
          )
        : null,
      footer,
      h(Text, { dimColor: true }, " "),
    ),
  );
}

// 仪表盘底栏按键：直观精炼，6 项常用操作
const DASHBOARD_KEYS = [
  ["↑↓", "选工具"],
  ["回车", "测隧道"],
  ["c", "配置"],
  ["空格", "启停"],
  ["u", "上游"],
  ["d", "域名"],
  ["r", "刷新/取消"],
  ["q", "退出"],
];

const SERVICE_KEYS = [
  ["s", "启停"],
  ["↑↓", "滚动"],
  ["Esc", "返回"],
];

const DOMAINS_KEYS = [
  ["a", "加规则"],
  ["d", "删选中"],
  ["↑↓", "选择"],
  ["Esc", "返回"],
];

const UPSTREAM_KEYS = [
  ["↑↓", "选择"],
  ["回车", "确认"],
  ["m", "手填"],
  ["Esc", "返回"],
];

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
  const onSigint = () => process.exit(130);
  process.on("SIGINT", onSigint);
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
  const state = await collectState({
    internalDns: options.internalDns,
    repoRoots: options.repoRoots ?? [],
    includeChrome: options.includeChrome ?? false,
  });

  // 非 TTY 的总览与仪表盘共用同一份判词（rowsFor/verdictFor），
  // 渲染走 report.js —— 不再借 ink 画纯文本。
  const lines = [];
  const rep = createReporter({ out: (line) => lines.push(line) });
  const verdict = verdictFor(state);
  rep.verdict(verdict.tone, verdict.text);
  rep.blank();
  rep.rows(rowsFor(state));

  rep.section("内网域名");
  if (state.internalDomains.length) {
    const nameWidth = Math.max(
      20,
      ...state.internalDomains.map((d) => d.name.length),
    );
    for (const d of state.internalDomains) {
      rep.line(`${d.name.padEnd(nameWidth)}  ${d.ips.join(", ")}`);
    }
  } else {
    rep.dim("（无）");
  }
  rep.blank();
  return `${lines.join("\n")}\n`;
}
