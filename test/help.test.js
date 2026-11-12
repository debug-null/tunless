import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToString, Box } from "ink";
import { nextSteps, HelpPanel, PROXY_INFO } from "../src/tui/help.js";
import { fullDiskAccessHint } from "../src/core/scan.js";
import { displayWidth } from "../src/tui/width.js";

const h = React.createElement;

test("下一步建议覆盖转发服务、程序与假 IP 三类问题", () => {
  const steps = nextSteps({
    core: { reachable: true },
    sidecar: { running: false, installed: false },
    processes: [{ comm: "somecli", status: "unsupported" }],
    fakeCount: 2,
    internalDomains: [{ name: "a.17usoft.com" }],
  });
  const text = steps.map((s) => s.text).join(" ");
  assert.match(text, /还没装/);
  assert.match(text, /somecli/);
  assert.match(text, /假 IP/);
  assert.ok(steps.every((s) => typeof s.text === "string" && s.text.length > 0));
});

test("转发服务已装且运行时建议用代理重启应用", () => {
  const steps = nextSteps({
    core: { reachable: true },
    sidecar: { running: true, installed: true },
    processes: [],
    fakeCount: 0,
    internalDomains: [],
  });
  const first = steps[0];
  assert.equal(first.key, "l");
  assert.match(first.text, /Antigravity/);
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
