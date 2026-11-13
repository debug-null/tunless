# tunless 仪表盘化 UI 改造实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 TUI 从线性五步向导改成「仪表盘为家 + 按键钻取」模型，并让 CLI 文本输出与仪表盘共用同一套状态判词。

**Architecture:** 新增纯函数 `src/core/status-rows.js`（每个子系统一行判词，TUI 与 CLI 共用）；新增零依赖渲染器 `src/cli/report.js`；`src/tui/` 按屏幕拆分为 `screens/` + `components/`；`app.js` 瘦身为路由器。spec：`docs/superpowers/specs/2026-11-13-tui-redesign-design.md`

**Tech Stack:** Node ≥22 ESM（stdlib only for core/cli）、ink + React（TUI，已有依赖）、`node:test` 测试。

**约定（全文通用）：**
- 测试命令统一为 `node --test test/<file>.test.js`；全量为 `node --test "test/*.test.js"`（当前基线 162 通过）
- 提交统一 `git -c user.name="Devin" -c user.email="158243242+devin-ai-integration[bot]@users.noreply.github.com" commit -m "..."`（仓库未配置作者信息时用 -c，已配置可省略）
- TUI 测试用 `test/tui.test.js` 里已有的 `shot()` 助手（ink `debug:true` + 假 Writable 渲染成文本，取最后一帧）
- 判词三态纪律：`ok|warn|bad|unknown`——「读不到」显示 unknown，绝不隐去

---

### Task 1: `src/core/status-rows.js` — 共用判词纯函数

**Files:**
- Create: `src/core/status-rows.js`
- Test: `test/status-rows.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/status-rows.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { rowsFor, verdictFor } from "../src/core/status-rows.js";

const base = {
  loading: false,
  sidecar: { running: true, installed: true, pid: 1234, httpPort: 8899, socksPort: 8898, activeSuffixes: ["17u.cn"], pendingSuffixes: [] },
  upstream: { pinned: null, chosen: { host: "127.0.0.1", port: 6478 }, detail: "wmsxwd", drift: null },
  apps: [
    { id: "antigravity", name: "Antigravity", installed: true, running: true, proxied: "ok" },
    { id: "cursor", name: "Cursor", installed: true, running: true, proxied: "ok" },
  ],
  dnsAlive: true,
  internalDns: "10.249.150.130",
  suffixes: ["17u.cn"],
  internalDomains: [{ name: "a.17u.cn", ips: ["10.0.0.1"] }],
  fakeCount: 0,
};

const byId = (rows, id) => rows.find((r) => r.id === id);

test("全健康：四行全 ok，判决一切正常", () => {
  const rows = rowsFor(base);
  assert.deepEqual(rows.map((r) => r.status), ["ok", "ok", "ok", "ok"]);
  assert.equal(verdictFor(base).tone, "ok");
});

test("服务停了：bad + 行内动作按 s", () => {
  const st = { ...base, sidecar: { ...base.sidecar, running: false } };
  const row = byId(rowsFor(st), "service");
  assert.equal(row.status, "bad");
  assert.match(row.action, /s/);
  assert.equal(verdictFor(st).tone, "bad");
});

test("服务从未安装：warn + 引导动作", () => {
  const st = { ...base, sidecar: { ...base.sidecar, running: false, installed: false } };
  const row = byId(rowsFor(st), "service");
  assert.equal(row.status, "warn");
  assert.match(row.action, /g/);
});

test("上游缺失：bad + 按 u", () => {
  const st = { ...base, upstream: { pinned: null, chosen: null, detail: "", drift: null } };
  assert.equal(byId(rowsFor(st), "upstream").status, "bad");
});

test("上游漂移：warn 而不是 ok", () => {
  const st = { ...base, upstream: { ...base.upstream, drift: "pinned 已过期" } };
  assert.equal(byId(rowsFor(st), "upstream").status, "warn");
});

test("工具 stale：warn；运行但未走代理：unknown 不记故障", () => {
  const stale = { ...base, apps: [{ ...base.apps[0], proxied: "stale" }, base.apps[1]] };
  assert.equal(byId(rowsFor(stale), "tools").status, "warn");
  const unknown = { ...base, apps: [{ ...base.apps[0], proxied: "unknown" }, base.apps[1]] };
  assert.equal(byId(rowsFor(unknown), "tools").status, "ok");
});

test("内网 DNS 死：warn；假 IP：bad + 按 f", () => {
  const dnsDead = { ...base, dnsAlive: false };
  assert.equal(byId(rowsFor(dnsDead), "internal").status, "warn");
  const fake = { ...base, fakeCount: 2 };
  const row = byId(rowsFor(fake), "internal");
  assert.equal(row.status, "bad");
  assert.match(row.action, /f/);
});

test("待生效后缀：warn 并给数字", () => {
  const st = { ...base, sidecar: { ...base.sidecar, pendingSuffixes: ["a.cn", "b.cn"] } };
  const row = byId(rowsFor(st), "internal");
  assert.equal(row.status, "warn");
  assert.match(row.detail, /2/);
});

test("loading：全 unknown，判决不报警", () => {
  const rows = rowsFor({ loading: true });
  assert.ok(rows.every((r) => r.status === "unknown"));
  assert.equal(verdictFor({ loading: true }).tone, "info");
});
```

- [ ] **Step 2: 验证失败**

Run: `node --test test/status-rows.test.js`
Expected: FAIL `Cannot find module '../src/core/status-rows.js'`

- [ ] **Step 3: 实现**

```js
// src/core/status-rows.js
// 仪表盘与 CLI 共用的子系统判词 —— 纯函数、零依赖。
// 「系统健不健康」只有这一种说法，TUI 和 doctor 不再各讲各的。
// 输入是 src/tui/state.js 的 collectState 产出（或其子集）。

export const ROW_ORDER = ["service", "upstream", "tools", "internal"];

const LABEL = { service: "服务", upstream: "上游", tools: "工具", internal: "内网" };

function row(id, status, detail, action = null) {
  return { id, status, label: LABEL[id], detail, action };
}

function serviceRow(state) {
  const s = state?.sidecar ?? {};
  if (state?.loading) return row("service", "unknown", "探测中");
  if (s.running) {
    return row("service", "ok",
      [`运行中${s.pid ? ` pid ${s.pid}` : ""}`, `HTTP :${s.httpPort ?? 8899}`, s.socksPort ? `SOCKS :${s.socksPort}` : null]
        .filter(Boolean).join(" · "));
  }
  if (s.installed) return row("service", "bad", "已停止", "按 s 启动");
  return row("service", "warn", "未安装", "按 g 进向导装上");
}

function upstreamRow(state) {
  const u = state?.upstream ?? {};
  if (state?.loading) return row("upstream", "unknown", "探测中");
  if (u.chosen) {
    const addr = `${u.chosen.host}:${u.chosen.port}`;
    if (u.drift) return row("upstream", "warn", `${addr}（你固定的已过期）`, "按 u 确认");
    const tag = u.detail ? ` · ${u.detail}` : "";
    return row("upstream", "ok", `${addr}${tag}`);
  }
  return row("upstream", "bad", "没找到可用上游", "按 u 手动选");
}

function toolsRow(state) {
  const apps = (state?.apps ?? []).filter((a) => a.installed);
  if (state?.loading) return row("tools", "unknown", "探测中");
  if (!apps.length) return row("tools", "warn", "没检测到支持的工具", "装 Antigravity / Cursor");
  const parts = apps.map((a) =>
    a.proxied === "ok" ? `${a.name} 代理中`
      : a.proxied === "stale" ? `${a.name} ⚠旧代理`
      : a.running ? `${a.name} 未走代理`
      : `${a.name} —`);
  const stale = apps.some((a) => a.proxied === "stale");
  const proxied = apps.some((a) => a.proxied === "ok");
  return row(
    "tools",
    stale ? "warn" : proxied ? "ok" : "unknown",
    parts.join(" · "),
    stale ? "回车看详情" : null,
  );
}

function internalRow(state) {
  if (state?.loading) return row("internal", "unknown", "探测中");
  if (state.dnsAlive === false)
    return row("internal", "warn", `内网 DNS ${state.internalDns ?? ""} 不可达`);
  if ((state.fakeCount ?? 0) > 0)
    return row("internal", "bad", `${state.fakeCount} 个内网后缀仍是假 IP`, "按 f 修复");
  const s = state?.sidecar ?? {};
  const active = s.activeSuffixes?.length ?? 0;
  const pending = s.pendingSuffixes?.length ?? 0;
  if (s.running) {
    const domainCount = state.internalDomains?.length ?? 0;
    return pending
      ? row("internal", "warn", `${active} 后缀分流中 · ${pending} 个待重启生效`, "d 查看")
      : row("internal", "ok", `${active} 后缀分流中${domainCount ? ` · ${domainCount} 域名` : ""}`);
  }
  const total = state.suffixes?.length ?? state.internalDomains?.length ?? 0;
  return total
    ? row("internal", "warn", `${total} 个待分流（服务未启动）`, "s 启动服务")
    : row("internal", "unknown", "没有内网域名需要分流");
}

export function rowsFor(state) {
  return ROW_ORDER.map((id) =>
    ({ service: serviceRow, upstream: upstreamRow, tools: toolsRow, internal: internalRow })[id](state));
}

/** 顶部总判决：bad 优先于 warn；全 unknown 是「探测中」不是故障。 */
export function verdictFor(state) {
  const rows = rowsFor(state);
  if (state?.loading || rows.every((r) => r.status === "unknown"))
    return { tone: "info", text: "正在探测…" };
  const bad = rows.filter((r) => r.status === "bad").length;
  if (bad) return { tone: "bad", text: `${bad} 处故障` };
  const warn = rows.filter((r) => r.status === "warn").length;
  if (warn) return { tone: "warn", text: `${warn} 处需要注意` };
  if (rows.every((r) => r.status === "ok")) return { tone: "ok", text: "一切正常" };
  return { tone: "ok", text: "正常" };
}
```

- [ ] **Step 4: 验证通过**

Run: `node --test test/status-rows.test.js`
Expected: 9 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/core/status-rows.js test/status-rows.test.js
git commit -m "feat: status-rows 共用判词（TUI 仪表盘与 CLI 输出单真相源）"
```

---

### Task 2: `src/cli/report.js` — 零依赖文本渲染器

**Files:**
- Create: `src/cli/report.js`
- Test: `test/report.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/report.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createReporter } from "../src/cli/report.js";

const capture = () => {
  const lines = [];
  return { lines, out: (t) => lines.push(t) };
};

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("row：状态符号 + 标签 + 详情 + 动作", () => {
  const { lines, out } = capture();
  const rep = createReporter({ color: false, unicode: true, out });
  rep.row("ok", "服务", "运行中 pid 1");
  rep.row("bad", "内核", "不可达", "按 f 修复");
  assert.equal(lines[0], "  ✔ 服务   运行中 pid 1");
  assert.equal(lines[1], "  ✖ 内核   不可达 · 按 f 修复");
});

test("unknown 显式显示而不是隐藏", () => {
  const { lines, out } = capture();
  createReporter({ color: false, unicode: true, out }).row("unknown", "TUN", "读不到");
  assert.match(lines[0], /\? TUN/);
});

test("ASCII 降级：TUNLESS_ASCII=1 风格符号", () => {
  const { lines, out } = capture();
  const rep = createReporter({ color: false, unicode: false, out });
  rep.row("ok", "服务", "好");
  rep.row("warn", "上游", "旧");
  rep.row("bad", "内核", "挂");
  assert.match(lines[0], /\+ 服务/);
  assert.match(lines[1], /! 上游/);
  assert.match(lines[2], /x 内核/);
});

test("color:false 时不带 ANSI；color:true 时上色", () => {
  const a = capture();
  createReporter({ color: false, out: a.out }).section("环境");
  assert.equal(strip(a.lines.at(-1)), a.lines.at(-1));
  const b = capture();
  createReporter({ color: true, unicode: true, out: b.out }).row("ok", "服务", "好");
  assert.notEqual(strip(b.lines[0]), b.lines[0]);
});

test("verdict/section/suggest 形状", () => {
  const { lines, out } = capture();
  const rep = createReporter({ color: false, unicode: true, out });
  rep.verdict("ok", "一切正常");
  rep.section("环境");
  rep.suggest("tunless service start");
  assert.equal(lines[0], " ● 一切正常");
  assert.equal(lines[2], "── 环境 ──");
  assert.equal(lines[3], "    → tunless service start");
});
```

- [ ] **Step 2: 验证失败**

Run: `node --test test/report.test.js`
Expected: FAIL `Cannot find module '../src/cli/report.js'`

- [ ] **Step 3: 实现**

```js
// src/cli/report.js — 零依赖文本报告渲染器。
// doctor/status/summary 与 TUI 仪表盘共用 src/core/status-rows.js 的判词；
// 本文件只负责把判词画成终端文本。颜色用 Node 22 自带的 util.styleText，
// 符号集复用 tui/theme.js（纯数据模块，不依赖 ink）。
import { styleText } from "node:util";
import { symbolSet, detectUnicode } from "../tui/theme.js";

const TONE_COLOR = { ok: "green", warn: "yellow", bad: "red", unknown: "gray", info: "cyan" };

export function createReporter({
  color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
  unicode = detectUnicode(),
  out = (line) => console.log(line),
} = {}) {
  const symbols = symbolSet(unicode);
  const paint = (tone, text) => (color ? styleText(TONE_COLOR[tone] ?? "reset", text) : text);
  const bold = (t) => (color ? styleText("bold", t) : t);
  const dimText = (t) => (color ? styleText("dim", t) : t);
  const mark = (status) =>
    status === "unknown" ? "?" : (symbols[status] ?? symbols.info);

  return {
    blank() {
      out("");
    },
    section(title) {
      out("");
      out(bold(`── ${title} ──`));
    },
    /** 子系统判词行：`  ✔ 服务   运行中 pid 1 · 按 s 启动` */
    row(status, label, detail = "", action = null) {
      const head = `  ${mark(status)} ${String(label).padEnd(4)}`;
      out(
        paint(status, head) +
          (detail ? ` ${detail}` : "") +
          (action ? dimText(` · ${action}`) : ""),
      );
    },
    /** 自由文本行（带两个空格缩进） */
    line(text = "") {
      out(`  ${text}`);
    },
    /** 次级说明（再缩进、降亮度） */
    dim(text) {
      out(`    ${dimText(text)}`);
    },
    /** 建议动作 */
    suggest(text) {
      out(`    ${dimText(`→ ${text}`)}`);
    },
    /** 顶部总判决 */
    verdict(tone, text) {
      out(paint(tone, ` ● ${text}`));
    },
    /** 直接把 rowsFor(state) 的结果倒出来 */
    rows(rowList) {
      for (const r of rowList) this.row(r.status, r.label, r.detail, r.action);
    },
  };
}
```

- [ ] **Step 4: 验证通过**

Run: `node --test test/report.test.js`
Expected: 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/cli/report.js test/report.test.js
git commit -m "feat: cli/report.js 统一文本渲染器（util.styleText + theme 符号集）"
```

---

### Task 3: TUI 组件层（status-row / key-bar / event-feed）

**Files:**
- Create: `src/tui/components/status-row.js`
- Create: `src/tui/components/key-bar.js`
- Create: `src/tui/components/event-feed.js`
- Test: `test/components.test.js`

- [ ] **Step 1: 写失败测试**

```js
// test/components.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import React from "react";
import { render } from "ink";
import { ThemeProvider } from "../src/tui/ui.js";
import { getTheme } from "../src/tui/theme.js";
import { StatusRow } from "../src/tui/components/status-row.js";
import { KeyBar } from "../src/tui/components/key-bar.js";
import { EventFeed } from "../src/tui/components/event-feed.js";

const h = React.createElement;
const wrap = (node) => h(ThemeProvider, { theme: getTheme("dark"), unicode: true }, node);

async function shot(node, columns = 100) {
  const chunks = [];
  const stream = new Writable({ write(c, _e, cb) { chunks.push(c.toString()); cb(); } });
  stream.columns = columns; stream.rows = 40; stream.isTTY = true;
  const inst = render(node, { stdout: stream, stderr: stream, debug: true, patchConsole: false });
  await new Promise((r) => setTimeout(r, 150));
  inst.unmount();
  const frames = chunks
    .map((c) => c.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""))
    .filter((c) => /[\u4e00-\u9fa5A-Za-z0-9]/.test(c));
  return frames.at(-1) ?? "";
}

test("StatusRow：图标 + 标签 + 详情 + 动作提示", async () => {
  const out = await shot(wrap(h(StatusRow, {
    row: { id: "service", status: "bad", label: "服务", detail: "已停止", action: "按 s 启动" },
    selected: false, width: 80,
  })));
  assert.match(out, /✖ 服务/);
  assert.match(out, /已停止/);
  assert.match(out, /按 s 启动/);
});

test("StatusRow：unknown 显式标问号", async () => {
  const out = await shot(wrap(h(StatusRow, {
    row: { id: "x", status: "unknown", label: "TUN", detail: "读不到", action: null },
    selected: false, width: 80,
  })));
  assert.match(out, /\? TUN/);
});

test("StatusRow：选中行有指针", async () => {
  const out = await shot(wrap(h(StatusRow, {
    row: { id: "x", status: "ok", label: "服务", detail: "好", action: null },
    selected: true, width: 80,
  })));
  assert.match(out, /❯/);
});

test("KeyBar：按键提示渲染", async () => {
  const out = await shot(wrap(h(KeyBar, { keys: [["s", "服务"], ["q", "退出"]] })));
  assert.match(out, /s 服务/);
  assert.match(out, /q 退出/);
});

test("EventFeed：只留最近 N 条", async () => {
  const events = Array.from({ length: 8 }, (_, i) => ({ time: `10:0${i}`, text: `事件${i}`, kind: "info" }));
  const out = await shot(wrap(h(EventFeed, { events, limit: 3 })));
  assert.match(out, /事件7/);
  assert.doesNotMatch(out, /事件0/);
});
```

- [ ] **Step 2: 验证失败**

Run: `node --test test/components.test.js`
Expected: FAIL `Cannot find module`

- [ ] **Step 3: 实现三个组件**

```js
// src/tui/components/status-row.js
// 仪表盘行：判词（icon+色） + 标签 + 详情 + 行尾动作提示。
// 数据来自 src/core/status-rows.js 的 rowsFor —— 本组件只管渲染。
import { Box, Text } from "ink";
import { h, useTheme, useUnicode, txt, segments } from "../ui.js";
import { symbolSet } from "../theme.js";
import { truncate, displayWidth, padEnd } from "../width.js";

const ICON = (symbols) => ({
  ok: symbols.ok, warn: symbols.warn, bad: symbols.bad, unknown: "?", info: symbols.info,
});

export function StatusRow({ row, selected = false, width = 80 }) {
  const theme = useTheme();
  const symbols = symbolSet(useUnicode());
  const color = { ok: theme.colors.ok, warn: theme.colors.warn, bad: theme.colors.bad, unknown: theme.colors.muted }[row.status] ?? theme.colors.text;
  const budget = Math.max(20, width - 24);
  const detail = truncate(row.detail ?? "", budget);
  const parts = [
    txt(selected ? " ❯ " : "   ", { color: selected ? theme.colors.accent : undefined, bold: selected }),
    txt(`${ICON(symbols)[row.status] ?? "?"} `, { color }),
    txt(padEnd(row.label, 5), { bold: true }),
    txt(detail, { color: row.status === "unknown" ? theme.colors.muted : undefined, dim: row.status === "unknown" }),
    row.action ? txt(`  · ${row.action}`, { color: theme.colors.accent }) : null,
  ].filter(Boolean);
  return h(Box, null, h(Text, null, ...segments(parts)));
}
```

```js
// src/tui/components/key-bar.js
// 底部按键提示条：当前屏幕可用的键，上下文感知。
import { Box, Text } from "ink";
import { h, useTheme, txt, segments } from "../ui.js";

export function KeyBar({ keys = [] }) {
  const theme = useTheme();
  const parts = keys.flatMap(([key, label], i) => [
    i ? txt("  ") : null,
    txt(` ${key} `, { color: theme.colors.accent, bold: true }),
    txt(label, { dim: true }),
  ]).filter(Boolean);
  return h(Box, null, h(Text, null, ...segments(parts)));
}
```

```js
// src/tui/components/event-feed.js
// 最近事件流：从 app.js 的 log() 事件环渲染最近 N 条，按 kind 着色。
import { Box, Text } from "ink";
import { h, useTheme } from "../ui.js";

export function EventFeed({ events = [], limit = 3 }) {
  const theme = useTheme();
  const KIND = { ok: theme.colors.ok, warn: theme.colors.warn, bad: theme.colors.bad };
  const tail = events.slice(-limit);
  return h(
    Box,
    { flexDirection: "column" },
    tail.map((e, i) =>
      h(
        Text,
        { key: `${e.time}-${i}` },
        h(Text, { dimColor: true }, `  ${e.time} `),
        h(Text, { color: KIND[e.kind] ?? theme.colors.text, dimColor: e.kind === "info" }, e.text),
      )),
  );
}
```

- [ ] **Step 4: 验证通过**

Run: `node --test test/components.test.js`
Expected: 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/tui/components/ test/components.test.js
git commit -m "feat: tui 组件层 status-row/key-bar/event-feed"
```

---

### Task 4: 仪表盘屏 + app.js 改路由器

**Files:**
- Create: `src/tui/screens/dashboard.js`
- Modify: `src/tui/app.js`（重写为路由壳 + 全局键 + 屏内键分派）
- Test: `test/dashboard.test.js`

**改造要点（app.js）：**

1. 新增屏幕状态：`const [screen, setScreen] = useState("dashboard")`，合法值 `dashboard|service|upstream|apps|domains|wizard|help`（helpOpen 保留为布尔覆盖层或并入 screen——实现时选并入 `helpOpen` 保持现状，避免一次改两处逻辑）
2. 向导内部状态改名隔离：现 `step`→`wizardStep`、`done`→`wizardDone`；`appIndex/appName/appId/upstreamIndex/editingUpstream/draftUpstream/verifying/verifyResult/stepResult/reach/...` 保持原样（它们既服务向导也服务钻取屏）
3. 删掉 Task E 加的「就绪自动跳结果页」（`setDone(true)` 那段 .then 块），替换为**首配检测**：`!next.upstream?.pinned && !next.sidecar?.installed && !next.upstream?.chosen` 时才 `setScreen("wizard")` + log 一句
4. `useInput` 结构改为三段：
   - 输入态守卫（editing/editingTarget/editingUpstream/helpOpen）——原样保留
   - 全局键：`q` 退出、`a` 加规则、`h`/`?` 帮助、`r` 刷新、`f` 修复、`s`/`S` 切服务
   - 屏幕键：dashboard（↑↓→rowIndex，Enter→钻取，u/d/l/g→对应屏）；wizard（现有 step1-5 逻辑原样，Esc 到底回 dashboard 而不是卡在 step1）；钻取屏在 Task 5/6 填充
5. body 渲染：`screen==="dashboard"` → `h(Dashboard, {state, rowIndex, width, events})`；`screen==="wizard"` → 现有 step JSX 原样（wizardDone→StepDone，且 StepDone 的回车改为 `setScreen("dashboard")`）
6. 底部：`StatusLine` + `EventFeed`(3 条) + `KeyBar`（dashboard 屏显示 `s 服务 u 上游 d 域名 l 日志 g 向导 r 刷新 q 退出`）

```js
// src/tui/screens/dashboard.js
// 仪表盘（家）：四行子系统判词 + 总判决 + 最近事件。
// 行的判词来自 src/core/status-rows.js —— CLI doctor 看到的是同一套说法。
import { Box, Text } from "ink";
import { h, useTheme, Card, txt } from "../ui.js";
import { rowsFor, verdictFor } from "../../core/status-rows.js";
import { StatusRow } from "../components/status-row.js";
import { EventFeed } from "../components/event-feed.js";

const TONE = (theme) => ({ ok: theme.colors.ok, warn: theme.colors.warn, bad: theme.colors.bad, info: theme.colors.info });

export function Dashboard({ state, rowIndex = 0, width = 80, events = [] }) {
  const theme = useTheme();
  const rows = rowsFor(state);
  const verdict = verdictFor(state);
  const tone = TONE(theme)[verdict.tone] ?? theme.colors.info;
  return h(
    Box,
    { flexDirection: "column" },
    h(Text, { color: tone, bold: true }, ` ● ${verdict.text}`),
    h(Text, null, " "),
    ...rows.map((row, i) =>
      h(StatusRow, { key: row.id, row, selected: i === rowIndex, width })),
    h(Text, null, " "),
    h(EventFeed, { events, limit: 3 }),
  );
}
```

**测试（test/dashboard.test.js）：** 用 `shot()` 断言：健康态出现 `一切正常` 与 `✔`；`sidecar.running=false` 时出现 `已停止` 与 `按 s 启动`；loading 态出现 `正在探测`；四行标签 `服务/上游/工具/内网` 都在。

- [ ] **Step 1: 写 dashboard.test.js 失败测试**
- [ ] **Step 2: `node --test test/dashboard.test.js` 确认 FAIL**
- [ ] **Step 3: 建 dashboard.js + 重写 app.js 路由（保留全部现有回调：refresh/runFix/runProxy/runService/launchApp/applyAppAction/runReach/adoptUpstream/confirmUpstream/saveDraft/deleteRule/refreshLive；只动状态名、屏幕分支、按键分派）**
- [ ] **Step 4: `node --test test/dashboard.test.js test/tui.test.js` 全过**
- [ ] **Step 5: `TUNLESS_TUI_DEBUG=1 node bin/tunless.js` 人工冒烟：落仪表盘、↑↓ 走行、Esc 行为**
- [ ] **Step 6: Commit `refactor: TUI 仪表盘为家 + app.js 改路由壳`**

---

### Task 5: 服务与日志屏 + 域名屏

**Files:**
- Create: `src/tui/screens/service.js`（服务状态卡 + 可滚动 EventFeed + s 启停）
- Create: `src/tui/screens/domains.js`（现 steps.js StepDomains 内容平移 + 手写规则列表 + `a`/`d` 键复用现有 saveDraft/deleteRule）
- Modify: `src/tui/app.js`（挂两屏的路由与按键）
- Test: `test/screens.test.js`

- [ ] **Step 1:** `service.js` 实现：顶部 `StatusRow`（service 行判词）+ `runtime.json` 摘要（`state.sidecar.runtime`：启动时间、上游、后缀数）+ EventFeed `limit` 随终端高度（`Math.max(5, rows-12)`）+ 页脚 `s 启停 · Esc 返回`
- [ ] **Step 2:** `domains.js` = steps.js StepDomains 的 rows 逻辑平移（含 dnsAlive 不可达提示、active/pending 区段、手动规则计数），加规则列表区（`flatRules()` 前 8 条 + 光标行 `ruleIndex`）+ 页脚 `a 加 · d 删 · Esc 返回`；`state.dnsAlive===false` 时规则区仍可用
- [ ] **Step 3:** app.js 接线：`screen==="service"` 时 `s` 走 `runService`、↑↓ 滚动事件起始索引（`eventScroll` state）；`screen==="domains"` 时 `a`→`setEditing("domain")`、`d`→`deleteRule`、`↑↓`→`ruleIndex`
- [ ] **Step 4:** `test/screens.test.js`：shot() 断言 service 屏出现 `运行中`/`已停止`、domains 屏出现 `正在分流`/待生效文案
- [ ] **Step 5:** 测试通过 + commit `feat: 服务与日志屏 + 域名规则屏`

---

### Task 6: 上游屏 + 工具屏

**Files:**
- Create: `src/tui/screens/upstream.js`（StepUpstream 平移：候选列表、m 手填、verifyResult；复用 adoptUpstream/confirmUpstream，确认后回 dashboard 而不是进向导 step3）
- Create: `src/tui/screens/apps.js`（StepApps 平移 + Enter 进单应用动作列表即 StepLaunch 内容；Esc 回列表/回 dashboard）
- Modify: `src/tui/app.js`
- Test: `test/screens.test.js`（追加用例）

- [ ] **Step 1:** upstream.js：抽 StepUpstream 的渲染为 `UpstreamScreen({state,index,pinned,editing,draft,verifying,verifyResult,width,embedded:false})`；steps.js 的 StepUpstream 改调它（向导内复用，防双份逻辑漂移）；`adoptUpstream` 成功后 `setScreen("dashboard")`（若 screen==="upstream"）而非 `setStep(3)`
- [ ] **Step 2:** apps.js：左列应用列表（复用 StepApps 行格式），选中应用回车后下方出动作菜单（`actionsFor(appId)`，复用 StepLaunch 的 option 行 + applyAppAction）；`live` 连接状态行照搬 StepLaunch 的 live 区
- [ ] **Step 3:** app.js 接线：`screen==="apps"` 的 ↑↓/Enter 两段态（list ↔ actions），`actionIndex/appIndex` 复用
- [ ] **Step 4:** 测试 + commit `feat: 上游屏与工具屏`

---

### Task 7: doctor 迁移到 reporter

**Files:**
- Modify: `src/cli.js`（cmdDoctor 段落）+ `src/cli.js` 顶部输出助手
- Test: `test/report.test.js` 追加 CLI 集成用例

- [ ] **Step 1:** cli.js 顶部：`createReporter({ out: say })` 注入现有 say（保 quiet/captured 机制）；`ok/warn/bad/info/dim/head` 保留供未迁移段落
- [ ] **Step 2:** cmdDoctor 各 `say(head("── xx ──"))` 改 `rep.section("xx")`；状态行（`say(\`  ${ok(...)}\`)`）改 `rep.row(status,label,detail)`；`dim` 建议行改 `rep.suggest`；进程表保留 `rep.line` 自由文本
- [ ] **Step 3:** `tunless doctor | head -40` 人工比对输出形状；`strip(ANSI)` 后无转义
- [ ] **Step 4:** 全量测试 + commit `refactor: doctor 走 report.js 统一输出`

---

### Task 8: 其余 CLI + 静态总览迁移

**Files:**
- Modify: `src/cli.js`（cmdService status/cmdUpstream status/cmdRules list/cmdEnv/cmdTargets/cmdFix 方案展示）
- Modify: `src/tui/app.js` 的 `renderStaticSummary`（OverviewPanel ink 渲染 → collectState + rep.rows(rowsFor(state))）
- Modify/Delete: `src/tui/panels.js`（OverviewPanel 退役；若仅静态总览在用则删）

- [ ] **Step 1:** `service status`/`upstream status`/`rules list`/`env`/`targets` 的 `say(...)` 逐段换 rep.row/line/suggest；`fix` 的方案清单用 rep.section+row
- [ ] **Step 2:** `renderStaticSummary` 改成：`collectState` → `createReporter` → `rep.verdict` + `rep.rows(rowsFor(state))` + 域名列表段（保留现有 nameWidth 对齐逻辑）
- [ ] **Step 3:** 删 OverviewPanel（先 grep 确认无其他引用 `grep -rn "OverviewPanel" src test`）；panels.js 若无残留导出则删文件
- [ ] **Step 4:** `node bin/tunless.js | head -30` 与 `tunless doctor` 目检；全量测试
- [ ] **Step 5:** commit `refactor: CLI 全量走 report.js，静态总览与仪表盘同判词`

---

### Task 9: 收尾验证

- [ ] **Step 1:** `node --test "test/*.test.js"` 全绿
- [ ] **Step 2:** `node --check` 全部改动文件
- [ ] **Step 3:** `TUNLESS_TUI_DEBUG=1 node bin/tunless.js` PTY 实测：仪表盘落地、故障行变色带动作、s 启停、Esc 回家、l 日志、g 向导五步可走通、窄终端（`columns=60`）不炸
- [ ] **Step 4:** `tunless doctor`、`service status`、`upstream status`、管道 `node bin/tunless.js` 目检一遍
- [ ] **Step 5:** commit（若 Step3/4 有修补）

---

## 自审记录

- Spec 覆盖：屏幕地图（T4-T6）、导航规则（T4）、自动进向导收窄（T4 Step3）、rowsFor 双渲染（T1/T7/T8）、降级（T2/T3）、测试（每 Task）、落地顺序（Task 序）——全覆盖
- 类型一致：`row.status`/`row.action`/`verdict.tone` 在 T1 定义、T3 渲染、T8 消费，名字一致
- 已知坑：`adoptUpstream` 里 `setStep(3)` 要在 T6 改成屏幕感知的返回；`refreshLive` 依赖 appId 的 ref 机制保留不动
