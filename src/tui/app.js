// TUI 主程序：负责渲染循环、按键分发和各类操作。

import { Screen } from "./screen.js";
import { createKeyParser } from "./keys.js";
import { collectState, emptyState } from "./state.js";
import {
  PANELS,
  renderOverview,
  renderDomains,
  renderProcesses,
  renderRoutes,
  renderEvents,
  renderFooter,
} from "./panels.js";
import { c, badge } from "./theme.js";
import { displayWidth } from "./width.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const RENDERERS = {
  overview: renderOverview,
  domains: renderDomains,
  processes: renderProcesses,
  routes: renderRoutes,
};

export class TuiApp {
  constructor({ internalDns, repoRoots = [], includeChrome = false } = {}) {
    this.internalDns = internalDns;
    this.repoRoots = repoRoots;
    this.includeChrome = includeChrome;
    this.screen = new Screen();
    this.state = emptyState();
    this.panel = "overview";
    this.events = [];
    this.dirty = false;
    this.busy = false;
    this.progress = "";
    this.hint = "";
    this.running = false;
    this.refreshTimer = null;
  }

  log(text, kind = "info") {
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    this.events.push({ time, text, kind });
    if (this.events.length > 200) this.events.shift();
  }

  async start() {
    this.running = true;
    this.screen.start();
    this.log("netfix 启动");

    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");

    const parser = createKeyParser((key) => this.onKey(key));
    this.onStdin = (chunk) => parser.handler(chunk);
    process.stdin.on("data", this.onStdin);

    process.on("SIGINT", () => this.quit());
    process.on("SIGTERM", () => this.quit());

    this.draw();
    await this.refresh();
    this.timer = setInterval(() => this.draw(), 1000);
  }

  quit() {
    if (!this.running) return;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    process.stdin.off("data", this.onStdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.pause();
    this.screen.stop();
    process.exit(0);
  }

  async refresh() {
    this.busy = true;
    this.progress = "正在启动…";
    this.draw();
    try {
      // 采集是分阶段的，每拿到一部分就更新界面，
      // 避免几秒钟的空白等待。
      const next = await collectState({
        internalDns: this.internalDns,
        repoRoots: this.repoRoots,
        includeChrome: this.includeChrome,
        onProgress: (stage, partial) => {
          this.progress = stage;
          this.state = { ...this.state, ...partial };
          this.draw();
        },
      });
      this.state = next;
      this.log(`状态已更新（内网域名 ${this.state.internalDomains.length} 个）`, "ok");
    } catch (err) {
      this.log(`刷新失败：${err.message}`, "bad");
    }
    this.busy = false;
    this.progress = "";
    this.dirty = false;
    this.draw();
  }


  async runAction(name) {
    if (this.busy) {
      this.hint = "正在处理中，请稍候";
      this.draw();
      return;
    }
    this.busy = true;
    this.hint = "";
    try {
      switch (name) {
        case "refresh":
          await this.refresh();
          return;
        case "fix":
          await this.runFix();
          return;
        case "proxy":
          await this.runProxy();
          return;
        case "service":
          await this.runService();
          return;
        case "launch":
          await this.runLaunch();
          return;
        default:
          break;
      }
    } catch (err) {
      this.log(`操作失败：${err.message}`, "bad");
    }
    this.busy = false;
    this.draw();
  }

  async runFix() {
    this.log("开始诊断并生成修复方案…", "info");
    this.draw();
    const { cmdFix, setQuiet } = await import("../cli.js");
    setQuiet(true);
    const args = {
      _: ["fix"],
      flags: {
        "internal-dns": this.internalDns,
        "no-chrome": this.includeChrome ? false : true,
        yes: true,
      },
    };
    const code = await cmdFix(args, { quiet: true });
    this.log(code === 0 ? "修复完成" : "修复未完成或已回滚", code === 0 ? "ok" : "warn");
    await this.refresh();
  }

  async runProxy() {
    const running = this.state.sidecar.running;
    if (running) {
      this.log("转发服务已在运行", "warn");
      return;
    }
    this.log("正在启动转发服务…", "info");
    this.draw();
    await exec("launchctl", [
      "kickstart",
      "-k",
      `gui/${process.getuid?.() ?? 501}/dev.netfix.proxy`,
    ], { timeout: 15000 }).catch((err) => {
      throw new Error(`启动失败：${err.message}`);
    });
    this.log("转发服务已启动", "ok");
    await this.refresh();
  }

  async runService() {
    this.log("正在切换转发服务状态…", "info");
    this.draw();
    const running = this.state.sidecar.running;
    const domain = `gui/${process.getuid?.() ?? 501}/dev.netfix.proxy`;
    if (running) {
      await exec("launchctl", ["bootout", domain], { timeout: 15000 });
      this.log("转发服务已停止", "warn");
    } else {
      await exec("launchctl", ["kickstart", "-k", domain], { timeout: 15000 });
      this.log("转发服务已启动", "ok");
    }
    await this.refresh();
  }

  async runLaunch() {
    const app = this.launchTarget || "Antigravity";
    this.log(`正在以 netfix 代理重启 ${app}…`, "info");
    this.draw();
    const { cmdLaunch, setQuiet } = await import("../cli.js");
    setQuiet(true);
    await cmdLaunch(
      {
        _: ["launch"],
        flags: {
          app,
          "internal-dns": this.internalDns,
          "no-chrome": this.includeChrome ? false : true,
        },
      },
      { quiet: true },
    );
    this.log(`${app} 已重启`, "ok");
    await this.refresh();
  }

  onKey(key) {
    if (key.name === "ctrl-c" || (key.name === "char" && key.char === "q")) {
      this.quit();
      return;
    }
    if (key.name === "char") {
      const panel = PANELS.find((p) => p.key === key.char);
      if (panel) {
        this.panel = panel.id;
        this.hint = "";
        this.draw();
        return;
      }
      switch (key.char) {
        case "r":
          this.runAction("refresh");
          return;
        case "f":
          this.runAction("fix");
          return;
        case "p":
          this.runAction("proxy");
          return;
        case "S":
          this.runAction("service");
          return;
        case "l":
          this.runAction("launch");
          return;
        case "j":
        case "down":
          this.cycle(1);
          return;
        case "k":
        case "up":
          this.cycle(-1);
          return;
        case "s":
          this.log("切换到总览", "info");
          this.panel = "overview";
          this.draw();
          return;
        default:
          break;
      }
    }
    if (key.name === "escape") {
      this.hint = "";
      this.draw();
    }
  }

  cycle(step) {
    const idx = PANELS.findIndex((p) => p.id === this.panel);
    const next = (idx + step + PANELS.length) % PANELS.length;
    this.panel = PANELS[next].id;
    this.draw();
  }

  draw() {
    const width = this.screen.width;
    const height = this.screen.height;
    const lines = [];

    // 标题栏
    const title = ` netfix `;
    const subtitle = c.dim("代理与内网诊断工具");
    const right = this.busy
      ? c.yellow(this.progress || "正在采集…")
      : this.state.updatedAt
        ? c.dim(`更新于 ${this.state.updatedAt.toLocaleTimeString("zh-CN", { hour12: false })}`)
        : c.dim("");
    const gap = width - displayWidth(title) - displayWidth(subtitle) - displayWidth(right) - 4;
    lines.push(
      `${c.bold(c.brightCyan(title))} ${subtitle}${" ".repeat(Math.max(1, gap))}${right}`,
    );
    lines.push(c.dim(SYMBOLS_HLINE(width)));

    const body = [];
    if (this.panel === "events") {
      body.push(...renderEvents(this.events, width));
    } else {
      const renderer = RENDERERS[this.panel];
      body.push(...renderer(this.state, width));
    }

    const footerLines = renderFooter(width, {
      active: this.panel,
      dirty: this.dirty,
      hint: this.hint || "r 刷新  ·  f 修复  ·  p 转发  ·  S 服务  ·  l 启动应用  ·  1-5 切换面板  ·  q 退出",
    });

    // 正文按可用高度裁剪，保证底部状态栏始终可见
    const available = height - 2 - footerLines.length;
    if (body.length > available) {
      body.splice(available - 1, body.length - available + 1, c.dim("  ……（内容过多，按面板切换查看）"));
    }
    lines.push(...body);
    lines.push(...footerLines);

    this.screen.render(lines);
  }
}

const SYMBOLS_HLINE = (n) => "─".repeat(Math.max(0, n));
