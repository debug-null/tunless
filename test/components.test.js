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
    .filter((c) => /[一-龥A-Za-z0-9]/.test(c));
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
