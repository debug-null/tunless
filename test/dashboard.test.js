import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import React from "react";
import { render } from "ink";
import { ThemeProvider } from "../src/tui/ui.js";
import { getTheme } from "../src/tui/theme.js";
import { Dashboard } from "../src/tui/screens/dashboard.js";

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

const healthy = {
  loading: false,
  sidecar: { running: true, installed: true, pid: 1, httpPort: 8899, socksPort: 8898, activeSuffixes: ["a.cn"], pendingSuffixes: [] },
  upstream: { pinned: null, chosen: { host: "127.0.0.1", port: 6478 }, detail: "wmsxwd", drift: null },
  apps: [{ name: "Cursor", installed: true, running: true, proxied: "ok" }],
  dnsAlive: true, internalDns: "10.0.0.1", suffixes: ["a.cn"],
  internalDomains: [{ name: "a.a.cn", ips: ["10.0.0.1"] }], fakeCount: 0,
};

test("健康态：一切正常 + 四行标签", async () => {
  const out = await shot(wrap(h(Dashboard, { state: healthy, rowIndex: 0, width: 100 })));
  assert.match(out, /一切正常/);
  for (const label of ["服务", "上游", "工具", "内网"]) assert.match(out, new RegExp(label));
});

test("故障态：已停止 + 按 s 启动", async () => {
  const st = { ...healthy, sidecar: { ...healthy.sidecar, running: false } };
  const out = await shot(wrap(h(Dashboard, { state: st, rowIndex: 0, width: 100 })));
  assert.match(out, /已停止/);
  assert.match(out, /按 s 启动/);
  assert.match(out, /1 处故障/);
});

test("loading：正在探测", async () => {
  const out = await shot(wrap(h(Dashboard, { state: { loading: true }, rowIndex: 0, width: 100 })));
  assert.match(out, /正在探测/);
});

test("最近事件渲染", async () => {
  const events = [{ time: "10:00", text: "服务重启完成", kind: "ok" }];
  const out = await shot(wrap(h(Dashboard, { state: healthy, rowIndex: 0, width: 100, events })));
  assert.match(out, /10:00 服务重启完成/);
});
