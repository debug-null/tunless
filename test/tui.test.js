import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import React from "react";
import { render, Box } from "ink";
import {
  displayWidth,
  truncate,
  padEnd,
  padStart,
  center,
  charWidth,
} from "../src/tui/width.js";
import { OverviewPanel } from "../src/tui/panels.js";
import { StepApps, StepLaunch, StepReach, StepDomains, StepDone, StatusLine } from "../src/tui/steps.js";
import { RulesPanel, MorePanel } from "../src/tui/rules-panel.js";
import { Card, kv, txt, ThemeProvider } from "../src/tui/ui.js";
import { getTheme, detectUnicode, symbolSet, borderSet } from "../src/tui/theme.js";
import { splitGraphemes } from "../src/tui/width.js";

const h = React.createElement;

/** 把 ink 组件渲染成纯文本，用来断言界面内容与对齐 */
async function shot(node, columns = 120) {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  stream.columns = columns;
  stream.rows = 40;
  stream.isTTY = true;
  const instance = render(node, {
    stdout: stream,
    stderr: stream,
    debug: true,
    patchConsole: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  instance.unmount();
  // debug 模式下每次渲染写一帧，这里只取最后一帧有效内容
  const frames = chunks
    .map((chunk) => chunk.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""))
    .filter((chunk) => /[\u4e00-\u9fa5A-Za-z0-9]/.test(chunk));
  return frames[frames.length - 1] ?? "";
}

const baseState = {
  loading: false,
  frontend: { label: "Clash Verge Rev" },
  core: {
    reachable: true,
    version: "v1.19.33",
    error: null,
    tun: false,
    mixedPort: 7897,
    mode: "rule",
  },
  systemProxy: { httpEnabled: true, httpsEnabled: true, host: "127.0.0.1", port: 7897 },
  sidecar: {
    running: true,
    pid: 85553,
    httpPort: 8899,
    socksPort: 8898,
    httpOpen: true,
    socksOpen: true,
  },
  internalDomains: [
    { name: "matrix.17usoft.com", ips: ["172.27.242.17"] },
    { name: "wiki.17u.cn", ips: ["172.27.242.12"] },
  ],
  publicCount: 3,
  fakeCount: 0,
  unresolvedCount: 1,
  suffixes: ["17u.cn", "17usoft.com"],
  processes: [{ pid: 1, comm: "antigravity", status: "supported" }],
  apps: [
    { id: "antigravity", name: "Antigravity", installed: true, running: true, version: "2.31.2" },
    { id: "cursor", name: "Cursor", installed: true, running: true, version: "3.28.7" },
  ],
  rules: { domain: [], keyword: [], cidr: [] },
  notes: [],
  errors: [],
  updatedAt: null,
};

test("中文按两个字符宽度计算", () => {
  assert.equal(displayWidth("内网域名"), 8);
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("内网 abc"), 8);
  assert.equal(charWidth("内".codePointAt(0)), 2);
  assert.equal(charWidth("a".codePointAt(0)), 1);
});

test("中文补空格按显示宽度对齐", () => {
  assert.equal(displayWidth(padEnd("内网", 10)), 10);
  assert.equal(displayWidth(padEnd("abc", 10)), 10);
  assert.equal(displayWidth(padStart("内网", 10)), 10);
  assert.equal(displayWidth(center("内网", 10)), 10);
});

test("超长中文按显示宽度截断并加省略号", () => {
  const cut = truncate("这是一个很长的中文字符串", 10);
  assert.ok(displayWidth(cut) <= 10);
  assert.ok(cut.endsWith("…"));
  assert.equal(truncate("短", 10), "短");
  assert.equal(truncate("abcdef", 3), "ab…");
});

test("总览面板渲染出关键状态", async () => {
  const text = await shot(
    h(Box, { flexDirection: "column", width: 120 }, h(OverviewPanel, { state: baseState, width: 120 })),
  );
  assert.match(text, /四步搞定/);
  assert.match(text, /选工具/);
  assert.match(text, /用代理启动/);
  assert.match(text, /测连通性/);
  assert.match(text, /内网域名/);
  assert.match(text, /8899/);
  assert.match(text, /Clash Verge Rev/);
  assert.match(text, /TUN/);
});

test("四步清单的标题列对齐（中文标题不错位）", async () => {
  const text = await shot(
    h(Box, { flexDirection: "column", width: 120 }, h(OverviewPanel, { state: baseState, width: 120 })),
  );
  const titles = ["选工具", "用代理启动", "测连通性", "内网域名"];
  const starts = titles.map((title) => {
    const line = text
      .split("\n")
      .find((l) => l.includes(title) && !l.includes("按 1"));
    assert.ok(line, `找不到步骤行：${title}`);
    const index = line.indexOf(title);
    // 标题后面的空白是补齐的，所以标题起点必须一致
    return displayWidth(line.slice(0, index));
  });
  assert.equal(new Set(starts).size, 1, `标题列终点不一致：${starts.join(",")}`);
});

test("规则面板显示自动扫描结果与手动规则", async () => {
  const state = {
    ...baseState,
    rules: { domain: ["17usoft.com"], keyword: ["jira"], cidr: ["10.0.0.0/8"] },
  };
  const text = await shot(
    h(Box, { flexDirection: "column", width: 120 }, h(RulesPanel, { state, width: 120, height: 24, scroll: 0 })),
  );
  assert.match(text, /自动扫描到的内网域名/);
  assert.match(text, /17usoft\.com/);
  assert.match(text, /jira/);
  assert.match(text, /10\.0\.0\.0\/8/);
  assert.match(text, /不需要任何授权/);
});

test("规则输入状态显示当前类型与提示", async () => {
  const text = await shot(
    h(
      Box,
      { flexDirection: "column", width: 120 },
      h(RulesPanel, { state: baseState, width: 120, height: 20, editing: "cidr", draft: "10.0.0" }),
    ),
  );
  assert.match(text, /10\.0\.0/);
  assert.match(text, /IP 段/);
  assert.match(text, /回车保存/);
});

test("更多面板收纳程序代理能力与分流后缀", async () => {
  const text = await shot(
    h(Box, { flexDirection: "column", width: 120 }, h(MorePanel, { state: baseState, width: 120 })),
  );
  assert.match(text, /程序代理能力/);
  assert.match(text, /antigravity/);
  assert.match(text, /分流后缀/);
});

test("emoji 组合序列按一个字素簇计算宽度", () => {
  // 家族 emoji 由多个码点加 ZWJ 组成，整体只占两列
  assert.equal(displayWidth("👨‍👩‍👧"), 2);
  assert.equal(splitGraphemes("👨‍👩‍👧").length, 1);
  // 截断不会把组合序列切坏
  const cut = truncate("👨‍👩‍👧家人们", 4);
  assert.ok(cut.endsWith("…"));
  assert.equal(displayWidth(cut) <= 4, true);
});

test("符号与边框可以降级成 ASCII", () => {
  assert.equal(symbolSet(true).ok, "✔");
  assert.equal(symbolSet(false).ok, "+");
  assert.equal(borderSet(true).vertical, "│");
  assert.equal(borderSet(false).vertical, "|");
});

test("UTF-8 环境用 Unicode 符号", () => {
  const saved = {
    LC_ALL: process.env.LC_ALL,
    LC_CTYPE: process.env.LC_CTYPE,
    LANG: process.env.LANG,
  };
  delete process.env.LC_ALL;
  delete process.env.LC_CTYPE;
  process.env.LANG = "zh_CN.UTF-8";
  assert.equal(detectUnicode(), true);
  process.env.LANG = "C";
  assert.equal(detectUnicode(), false);
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("卡片每一行的显示宽度一致（中文不撑破边框）", async () => {
  const rows = [
    kv("客户端", [txt("Clash Verge Rev")]),
    kv("内网域名", [txt("16 个解析到私网地址")]),
    [txt("  只有完全忽略代理的程序才需要它", { dim: true })],
  ];
  const text = await shot(
    h(
      ThemeProvider,
      { theme: getTheme("dark"), unicode: true },
      h(Box, { flexDirection: "column" }, h(Card, { title: "代理内核", width: 48, rows })),
    ),
  );
  const widths = text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => displayWidth(line));
  assert.ok(widths.length >= 4, `卡片行数不足：${widths.length}`);
  assert.equal(new Set(widths).size, 1, `卡片各行宽度不一致：${widths.join(",")}`);
});

test("亮色主题用深色前景字，暗色主题用白色", () => {
  assert.equal(getTheme("dark").colors.text, "white");
  assert.equal(getTheme("light").colors.text, "black");
  assert.equal(getTheme("light").colors.warn, "magenta");
});

test("总览面板带提示时也能渲染（回归：cardWidth 提前使用会 TDZ 报错）", async () => {
  const state = {
    ...baseState,
    notes: [
      "chrome-history: 权限不足 — 请给终端授予「完全磁盘访问权限」以获取更完整的域名列表",
    ],
  };
  const text = await shot(
    h(
      Box,
      { flexDirection: "column", width: 120 },
      h(OverviewPanel, { state, width: 120 }),
    ),
  );
  assert.match(text, /提示/);
  assert.match(text, /完全磁盘访问权限/);
});

test("向导第 1 步列出已安装的工具", async () => {
  const text = await shot(
    h(Box, { flexDirection: "column", width: 120 }, h(StepApps, { state: baseState, width: 120, index: 0 })),
  );
  assert.match(text, /第 1 步 \/ 共 4 步/);
  assert.match(text, /Antigravity/);
  assert.match(text, /Cursor/);
  assert.match(text, /回车下一步/);
});

test("向导第 2 步列出转发服务状态和三种处理方式", async () => {
  const text = await shot(
    h(
      Box,
      { flexDirection: "column", width: 120 },
      h(StepLaunch, { state: baseState, width: 120, index: 0, appName: "Antigravity", result: null }),
    ),
  );
  assert.match(text, /第 2 步 \/ 共 4 步/);
  assert.match(text, /转发服务/);
  assert.match(text, /只注入代理环境变量后启动/);
  assert.match(text, /写入代理配置/);
});

test("向导第 2 步执行后显示结果并提示进入下一步", async () => {
  const text = await shot(
    h(
      Box,
      { flexDirection: "column", width: 120 },
      h(StepLaunch, {
        state: baseState,
        width: 120,
        index: 0,
        appName: "Antigravity",
        result: "✔ Antigravity 已带代理启动",
      }),
    ),
  );
  assert.match(text, /已带代理启动/);
  assert.match(text, /回车进入下一步/);
});

test("第 2 步按应用过滤选项：Cursor 不给「只注入环境变量」这个没用��选项", async () => {
  const antigravity = await shot(
    h(
      Box,
      { flexDirection: "column", width: 120 },
      h(StepLaunch, {
        state: baseState,
        width: 120,
        index: 0,
        appName: "Antigravity",
        appId: "antigravity",
        result: null,
      }),
    ),
  );
  assert.match(antigravity, /Antigravity：模型请求认 HTTPS_PROXY/);
  assert.match(antigravity, /只注入代理环境变量后启动/);

  const cursor = await shot(
    h(
      Box,
      { flexDirection: "column", width: 120 },
      h(StepLaunch, {
        state: baseState,
        width: 120,
        index: 0,
        appName: "Cursor",
        appId: "cursor",
        result: null,
      }),
    ),
  );
  assert.match(cursor, /Cursor：模型请求不认环境变量代理/);
  // Cursor 的列表里不该再出现「只注入代理环境变量」——它对 Cursor 是没用的
  assert.doesNotMatch(cursor, /只注入代理环境变量后启动/);
  assert.match(cursor, /注入环境变量 \+ 写入代理配置后启动/);
});

test("向导第 3 步显示实测结果", async () => {
  const text = await shot(
    h(
      Box,
      { flexDirection: "column", width: 120 },
      h(StepReach, { state: baseState, width: 120, reachability: { ok: true, detail: "github.com 经代理返回 200", ms: 700 } }),
    ),
  );
  assert.match(text, /第 3 步 \/ 共 4 步/);
  assert.match(text, /github\.com 经代理返回 200/);
});

test("向导第 4 步列出内网域名，收尾页给出结果", async () => {
  const text = await shot(
    h(Box, { flexDirection: "column", width: 120 }, h(StepDomains, { state: baseState, width: 120 })),
  );
  assert.match(text, /第 4 步 \/ 共 4 步/);
  assert.match(text, /matrix\.17usoft\.com/);

  const done = await shot(
    h(
      Box,
      { flexDirection: "column", width: 120 },
      h(StepDone, { state: baseState, width: 120, appName: "Cursor", reachability: { ok: true, detail: "ok" } }),
    ),
  );
  assert.match(done, /全部搞定/);
  assert.match(done, /Cursor/);
});

test("状态行：用户触发的动作高亮显示，后台采集用安静的措辞", async () => {
  const running = await shot(
    h(
      Box,
      { flexDirection: "column", width: 120 },
      h(StatusLine, { executing: "正在以 tunless 代理重启 Cursor…", progress: null, updatedAt: null }),
    ),
  );
  assert.match(running, /⟳ 正在以 tunless 代理重启 Cursor/);

  const background = await shot(
    h(
      Box,
      { flexDirection: "column", width: 120 },
      h(StatusLine, { executing: null, progress: "正在扫描域名…", updatedAt: null }),
    ),
  );
  assert.match(background, /后台自动进行/);
  assert.doesNotMatch(background, /⟳/);
});

test("第 2 步：Codex 配置对了但客户端还连着旧代理时，明确说要重启", async () => {
  const text = await shot(
    h(
      Box,
      { flexDirection: "column", width: 120 },
      h(StepLaunch, {
        state: baseState,
        width: 120,
        index: 0,
        appName: "Codex",
        appId: "codex",
        result: null,
        desktop: { running: true, pids: [1], ports: [7897] },
      }),
    ),
  );
  assert.match(text, /客户端实际/);
  assert.match(text, /还连着 127\.0\.0\.1:7897/);
  assert.match(text, /需要重启客户端/);
});

test("第 2 步：客户端已经走 8899 时显示已生效", async () => {
  const text = await shot(
    h(
      Box,
      { flexDirection: "column", width: 120 },
      h(StepLaunch, {
        state: baseState,
        width: 120,
        index: 0,
        appName: "Codex",
        appId: "codex",
        result: null,
        desktop: { running: true, pids: [1], ports: [8899] },
      }),
    ),
  );
  assert.match(text, /已走 127\.0\.0\.1:8899/);
  assert.doesNotMatch(text, /需要重启客户端/);
});
