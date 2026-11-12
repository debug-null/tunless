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
import { OverviewPanel, DomainsPanel, ProcessesPanel, EventsPanel } from "../src/tui/panels.js";

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

test("域名表格列对齐且中文不错位", async () => {
  const text = await shot(
    h(Box, { flexDirection: "column", width: 120 }, h(DomainsPanel, { state: baseState, width: 120, height: 20, scroll: 0, query: "" })),
  );
  const rows = text.split("\n").filter((line) => /17usoft\.com|17u\.cn/.test(line));
  assert.equal(rows.length, 2);
  const columnOf = (line, needle) => displayWidth(line.slice(0, line.indexOf(needle)));
  const ipColumn = rows.map((line) => columnOf(line, line.match(/\d+\.\d+\.\d+\.\d+/)[0]));
  assert.equal(ipColumn[0], ipColumn[1], "解析地址列没有对齐");
  const judgeColumn = rows.map((line) => columnOf(line, "私网"));
  assert.equal(judgeColumn[0], judgeColumn[1], "判定列没有对齐");
});

test("搜索过滤只保留匹配的域名", async () => {
  const text = await shot(
    h(Box, { flexDirection: "column", width: 120 }, h(DomainsPanel, { state: baseState, width: 120, height: 20, scroll: 0, query: "wiki" })),
  );
  assert.match(text, /wiki\.17u\.cn/);
  assert.doesNotMatch(text, /matrix\.17usoft\.com/);
});

test("程序面板渲染代理能力判定", async () => {
  const text = await shot(
    h(Box, { flexDirection: "column", width: 120 }, h(ProcessesPanel, { state: baseState, height: 20, scroll: 0 })),
  );
  assert.match(text, /antigravity/);
  assert.match(text, /支持/);
});

test("日志面板渲染带时间的记录", async () => {
  const text = await shot(
    h(Box, { flexDirection: "column", width: 120 }, h(EventsPanel, { events: [{ time: "12:00:00", text: "状态已更新", kind: "ok" }] })),
  );
  assert.match(text, /12:00:00/);
  assert.match(text, /状态已更新/);
});
