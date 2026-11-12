import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToString, Box } from "ink";
import { nextSteps, HelpPanel, PROXY_INFO } from "../src/tui/help.js";
import { fullDiskAccessHint } from "../src/core/scan.js";
import { displayWidth } from "../src/tui/width.js";

const h = React.createElement;

test("一次只给一个下一步，避免用户不知道该按哪个", () => {
  const steps = nextSteps({
    core: { reachable: true },
    sidecar: { running: false, installed: false },
    processes: [{ comm: "somecli", status: "unsupported" }],
    fakeCount: 2,
    internalDomains: [{ name: "a.17usoft.com" }],
  });
  // 没装服务时，最该做的是装服务，不该同时抛出一堆问题
  assert.equal(steps.length, 1);
  assert.equal(steps[0].key, "s");
  assert.match(steps[0].text, /转发服务/);
});

test("内核不可达时先解决内核", () => {
  const steps = nextSteps({ core: { reachable: false }, sidecar: {}, processes: [], fakeCount: 0 });
  assert.equal(steps.length, 1);
  assert.match(steps[0].text, /内核/);
});

test("服务正常且有假 IP 时优先修 DNS", () => {
  const steps = nextSteps({
    core: { reachable: true },
    sidecar: { running: true, installed: true },
    processes: [],
    fakeCount: 2,
    internalDomains: [],
  });
  assert.equal(steps[0].key, "f");
  assert.match(steps[0].text, /假 IP/);
});

test("转发服务已装且运行时建议用代理重启应用，并提示可手写域名", () => {
  const steps = nextSteps({
    core: { reachable: true },
    sidecar: { running: true, installed: true },
    processes: [],
    fakeCount: 0,
    internalDomains: [],
  });
  assert.equal(steps[0].key, "l");
  assert.match(steps[0].text, /Antigravity|Cursor/);
  assert.ok(steps.some((s) => s.key === "a"), "应提示可以手写内网规则");
});

test("帮助面板讲清楚是什么、给谁用、代理填什么", () => {
  const text = renderToString(
    h(Box, { flexDirection: "column", width: 120 }, h(HelpPanel, { width: 120 })),
  );
  assert.match(text, /这是什么/);
  assert.match(text, /Antigravity/);
  assert.match(text, /怎么用/);
  assert.match(text, /代理填什么/);
  assert.match(text, /127\.0\.0\.1/);
  assert.match(text, /8899/);
  assert.match(text, /TUN/);
});

test("帮助面板每一行都在边框内", () => {
  const text = renderToString(
    h(Box, { flexDirection: "column", width: 120 }, h(HelpPanel, { width: 120 })),
  );
  const widths = text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => displayWidth(line));
  assert.ok(widths.every((w) => w <= 78), `有行超出卡片宽度：${Math.max(...widths)}`);
});

test("权限提示写清楚设置路径", () => {
  const hint = fullDiskAccessHint();
  assert.match(hint, /系统设置/);
  assert.match(hint, /隐私与安全性/);
  assert.match(hint, /完全磁盘访问权限/);
});

test("代理地址常量与界面里写的一致", () => {
  assert.equal(PROXY_INFO.http, "http://127.0.0.1:8899");
  assert.equal(PROXY_INFO.socks, "socks5://127.0.0.1:8898");
});
