import { test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";
import React from "react";
import { render } from "ink";
import { ThemeProvider } from "../src/tui/ui.js";
import { getTheme } from "../src/tui/theme.js";
import { ServiceScreen } from "../src/tui/screens/service.js";
import { DomainsScreen } from "../src/tui/screens/domains.js";

const h = React.createElement;
const wrap = (node) => h(ThemeProvider, { theme: getTheme("dark"), unicode: true }, node);

// 与 test/dashboard.test.js 同款 harness：ink debug 渲染取最后一帧
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

const base = {
  loading: false,
  sidecar: {
    running: true,
    installed: true,
    pid: 4321,
    httpPort: 8899,
    socksPort: 8898,
    runtime: {
      pid: 4321,
      startedAt: "2026-11-13T10:00:00.000Z",
      upstream: { host: "127.0.0.1", port: 6478 },
      suffixes: ["a.cn", "b.cn"],
    },
    activeSuffixes: ["a.cn", "b.cn"],
    pendingSuffixes: [],
  },
  upstream: { pinned: null, chosen: { host: "127.0.0.1", port: 6478 }, detail: "", drift: null },
  apps: [],
  dnsAlive: true,
  internalDns: "10.0.0.1",
  suffixes: ["a.cn", "b.cn"],
  internalDomains: [{ name: "x.a.cn", ips: ["10.0.0.1"] }],
  fakeCount: 0,
  rules: { domain: [], keyword: [], cidr: [] },
};

test("service 屏：运行中 + pid + 事件条目", async () => {
  const events = [{ time: "10:00", text: "服务重启完成", kind: "ok" }];
  const out = await shot(
    wrap(h(ServiceScreen, { state: base, width: 100, events, eventScroll: 0, rows: 40 })),
  );
  assert.match(out, /运行中/);
  assert.match(out, /4321/);
  assert.match(out, /服务重启完成/);
});

test("service 屏：未安装如实说", async () => {
  const st = {
    ...base,
    sidecar: { ...base.sidecar, running: false, installed: false, runtime: null },
  };
  const out = await shot(
    wrap(h(ServiceScreen, { state: st, width: 100, events: [], eventScroll: 0, rows: 40 })),
  );
  assert.match(out, /未安装/);
});

test("domains 屏：生效中与待生效分开说", async () => {
  const st = {
    ...base,
    sidecar: {
      ...base.sidecar,
      activeSuffixes: ["a.cn", "b.cn"],
      pendingSuffixes: ["c.cn"],
    },
  };
  const out = await shot(
    wrap(h(DomainsScreen, { state: st, width: 100, ruleIndex: 0, rules: [] })),
  );
  assert.match(out, /正在分流 2 个后缀/);
  assert.match(out, /1 个后缀要重启服务才生效/);
});

test("domains 屏：内网 DNS 不可达明说", async () => {
  const st = { ...base, dnsAlive: false, internalDomains: [] };
  const out = await shot(
    wrap(h(DomainsScreen, { state: st, width: 100, ruleIndex: 0, rules: [] })),
  );
  assert.match(out, /不可达/);
  assert.match(out, /不在公司网络/);
});

test("domains 屏：手写规则列出内容与光标", async () => {
  const rules = [
    { kind: "domain", value: "jira.17u.cn" },
    { kind: "keyword", value: "wiki" },
  ];
  const out = await shot(
    wrap(h(DomainsScreen, { state: base, width: 100, ruleIndex: 0, rules })),
  );
  assert.match(out, /jira\.17u\.cn/);
  assert.match(out, /wiki/);
  // 光标行前缀是主题箭头（unicode 下为 ›）
  assert.match(out, /›/);
});
