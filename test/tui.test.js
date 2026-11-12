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
  assert.match(text, /代理内核/);
  assert.match(text, /Clash Verge Rev/);
  assert.match(text, /TUN 模式/);
  assert.match(text, /已关闭/);
  assert.match(text, /127\.0\.0\.1:8899/);
});

test("键值行的值按显示宽度对齐（中文标题不错位）", async () => {
  const text = await shot(
    h(Box, { flexDirection: "column", width: 120 }, h(OverviewPanel, { state: baseState, width: 120 })),
  );
  const rows = text.split("\n").filter((line) => /客户端|内核版本|混合端口/.test(line));
  assert.equal(rows.length, 3);
  // 「客户端」（6 列）与「内核版本」（8 列）标题宽度不同，值的起始列必须一致
  const starts = rows.map((line) => {
    const m = /^\s*(\S+)\s+(\S.*)$/.exec(line);
    assert.ok(m, `无法解析行：${line}`);
    return displayWidth(line.slice(0, m.index + m[0].indexOf(m[2])));
  });
  assert.equal(new Set(starts).size, 1, `值列起点不一致：${starts.join(",")}`);
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
