import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import React from "react";
import { render } from "ink";
import { ThemeProvider } from "../src/tui/ui.js";
import { getTheme } from "../src/tui/theme.js";
import { Workbench } from "../src/tui/screens/workbench.js";

const h = React.createElement;

async function shot(node, columns = 80) {
  const chunks = [];
  const stream = new Writable({
    write(c, _e, cb) {
      chunks.push(c.toString());
      cb();
    },
  });
  stream.columns = columns;
  stream.rows = 30;
  stream.isTTY = true;
  const inst = render(node, { stdout: stream, stderr: stream, debug: true, patchConsole: false });
  await new Promise((r) => setTimeout(r, 150));
  inst.unmount();
  const frames = chunks
    .map((c) => c.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ""))
    .filter((c) => /[\u4e00-\u9fa5A-Za-z0-9]/.test(c));
  return frames.at(-1) ?? "";
}

const mockState = {
  sidecar: {
    running: true,
    httpPort: 8899,
    socksPort: 8898,
  },
  upstream: {
    chosen: { host: "127.0.0.1", port: 7897 },
    detail: "Clash Verge",
  },
  apps: [
    { id: "cursor", name: "Cursor", installed: true, running: true, proxied: "ok", mainPid: 54904 },
    { id: "antigravity", name: "Antigravity", installed: true, running: true, proxied: "ok", mainPid: 48921 },
    { id: "codex", name: "Codex", installed: true, running: false, proxied: null },
  ],
  internalDomains: [{ name: "matrix.17usoft.com", ips: ["10.0.0.1"] }],
  suffixes: ["17usoft.com"],
};

test("Workbench：暗色主题下渲染正常，包含标题、状态和应用", async () => {
  const node = h(
    ThemeProvider,
    { theme: getTheme("dark"), unicode: true },
    h(Workbench, { state: mockState, appIndex: 0 }),
  );
  const out = await shot(node);
  assert.match(out, /tunless/);
  assert.match(out, /转发服务/);
  assert.match(out, /上游代理/);
  assert.match(out, /Cursor/);
  assert.match(out, /Antigravity/);
  assert.match(out, /Codex/);
  assert.match(out, /8899/);
});

test("Workbench：亮色主题下同样渲染正常，文本无硬编码白字隐形", async () => {
  const node = h(
    ThemeProvider,
    { theme: getTheme("light"), unicode: true },
    h(Workbench, { state: mockState, appIndex: 1 }),
  );
  const out = await shot(node);
  assert.match(out, /tunless/);
  assert.match(out, /Antigravity/);
  assert.match(out, /8899/);
});

test("Workbench：状态简报用 rowsFor 判词，不编造没测过的结论", async () => {
  const node = h(
    ThemeProvider,
    { theme: getTheme("dark"), unicode: true },
    h(Workbench, { state: mockState, appIndex: 0, width: 80 }),
  );
  const out = await shot(node);
  // 判词行存在
  assert.match(out, /转发服务/);
  assert.match(out, /上游代理/);
  assert.match(out, /内网分流/);
  // 不许出现没验证过的乐观结论
  assert.doesNotMatch(out, /握手正常/);
});

test("Workbench：hint 传进来真的要渲染（回归：反馈通道曾全灭）", async () => {
  const node = h(
    ThemeProvider,
    { theme: getTheme("dark"), unicode: true },
    h(Workbench, { state: mockState, appIndex: 0, hint: "✔ Cursor 代理配置已生效" }),
  );
  const out = await shot(node);
  assert.match(out, /Cursor 代理配置已生效/);
});

test("Workbench：executing 时 hint 让位给执行中文案", async () => {
  const node = h(
    ThemeProvider,
    { theme: getTheme("dark"), unicode: true },
    h(Workbench, {
      state: mockState,
      appIndex: 0,
      hint: "✔ 旧消息",
      executing: "正在为 Cursor 配置代理",
    }),
  );
  const out = await shot(node);
  assert.match(out, /正在执行/);
  assert.doesNotMatch(out, /旧消息/);
});

test("Workbench：ASCII 降级不吐 Unicode 符号", async () => {
  const node = h(
    ThemeProvider,
    { theme: getTheme("dark"), unicode: false },
    h(Workbench, { state: mockState, appIndex: 0 }),
  );
  const out = await shot(node);
  assert.doesNotMatch(out, /●|○|❯|─|▲/);
  assert.match(out, />/); // arrow 降级为 >
});
