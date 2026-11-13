import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stripJsonc,
  applyCursorSettingsText,
  planCursorSettings,
  http2TunnelSupported,
  parseVersion,
} from "../src/core/apps.js";

test("JSONC 能容忍注释和尾逗号", () => {
  const text = `{
    // 这是注释
    "editor.fontSize": 14,
    /* 块注释 */
    "workbench.colorTheme": "Dark", // 行尾注释
  }`;
  const parsed = JSON.parse(stripJsonc(text));
  assert.equal(parsed["editor.fontSize"], 14);
  assert.equal(parsed["workbench.colorTheme"], "Dark");
});

test("字符串里的 // 不会被当成注释", () => {
  const parsed = JSON.parse(stripJsonc('{"url": "https://example.com/a//b"}'));
  assert.equal(parsed.url, "https://example.com/a//b");
});

test("Cursor 3.28+ 不需要关 HTTP/2，更早版本必须关", () => {
  assert.equal(http2TunnelSupported("3.28.7"), true);
  assert.equal(http2TunnelSupported("3.29.0"), true);
  assert.equal(http2TunnelSupported("3.27.9"), false);
  assert.equal(http2TunnelSupported("4.0.0"), true);
  assert.deepEqual(parseVersion("3.28.7"), [3, 28, 7]);

  const modern = planCursorSettings({ proxyUrl: "http://127.0.0.1:8899", version: "3.28.7" });
  assert.equal(modern.changes["cursor.general.disableHttp2"], false);
  assert.equal(modern.warnings.length, 0);

  const old = planCursorSettings({ proxyUrl: "http://127.0.0.1:8899", version: "3.20.1" });
  assert.equal(old.changes["cursor.general.disableHttp2"], true);
  assert.match(old.warnings[0], /HTTP\/2/);
});

test("写入已有键时保留原文件其它内容与缩进", () => {
  const raw = `{
  "editor.fontSize": 14,
  "http.proxy": "http://old:1234",
  "workbench.iconTheme": "vscode-icons"
}
`;
  const next = applyCursorSettingsText(raw, {
    "http.proxy": "http://127.0.0.1:8899",
    "http.proxySupport": "override",
  });
  const parsed = JSON.parse(next);
  assert.equal(parsed["http.proxy"], "http://127.0.0.1:8899");
  assert.equal(parsed["http.proxySupport"], "override");
  assert.equal(parsed["editor.fontSize"], 14, "原有键不能丢");
  assert.equal(parsed["workbench.iconTheme"], "vscode-icons");
});

test("缺失的键插入到末尾，且不破坏逗号", () => {
  const raw = `{
  "editor.fontSize": 14
}
`;
  const next = applyCursorSettingsText(raw, {
    "http.proxy": "http://127.0.0.1:8899",
    "http.proxySupport": "override",
    "cursor.general.disableHttp2": false,
  });
  const parsed = JSON.parse(next);
  assert.equal(parsed["editor.fontSize"], 14);
  assert.equal(parsed["http.proxy"], "http://127.0.0.1:8899");
  assert.equal(parsed["http.proxySupport"], "override");
  assert.equal(parsed["cursor.general.disableHttp2"], false);
});

test("空配置也能生成合法 JSON", () => {
  const next = applyCursorSettingsText("", { "http.proxy": "http://127.0.0.1:8899" });
  assert.equal(JSON.parse(next)["http.proxy"], "http://127.0.0.1:8899");
});

test("mainPid 对未运行的应用返回 null 而不抛错", async () => {
  const { mainPid } = await import("../src/core/apps.js");
  const result = await mainPid({ bundle: "TunlessNoSuchAppForTest" });
  assert.equal(result, null);
});

test("quitApp 对未运行的应用直接返回成功", async () => {
  const { quitApp } = await import("../src/core/apps.js");
  const result = await quitApp({ bundle: "TunlessNoSuchAppForTest" });
  assert.equal(result.quit, true);
  assert.equal(result.pid, null);
  assert.equal(result.escalated, false);
});

test("parseProxyPorts：只认真正的代理端口，忽略应用自身 IPC", async () => {
  const { parseProxyPorts } = await import("../src/core/apps.js");
  // 真实 lsof 输出的列布局：COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
  const lsof = [
    "language_ 23236 apple    7u  IPv4 0xa42c 0t0 TCP 127.0.0.1:54310 (LISTEN)",
    "language_ 23236 apple    9u  IPv4 0xbd20 0t0 TCP 127.0.0.1:54617->127.0.0.1:8899 (ESTABLISHED)",
    "language_ 23236 apple  304u  IPv4 0x8ca8 0t0 TCP 127.0.0.1:54310->127.0.0.1:54321 (ESTABLISHED)",
    "language_ 23236 apple  305u  IPv4 0x5144 0t0 TCP 127.0.0.1:54335->127.0.0.1:8899 (ESTABLISHED)",
    "Antigravi 23295 apple   22u  IPv4 0x5297 0t0 TCP 127.0.0.1:54344->127.0.0.1:54368 (ESTABLISHED)",
    "Other     99999 apple   1u  IPv4 0xdead 0t0 TCP 127.0.0.1:50000->127.0.0.1:7897 (ESTABLISHED)",
  ].join("\n");

  assert.deepEqual(parseProxyPorts(lsof, [23236, 23295]), [8899]);
  assert.deepEqual(parseProxyPorts(lsof, []), []);
});

test("parseProxyPorts：Clash 端口也能认出来，不被临时端口规则误杀", async () => {
  const { parseProxyPorts } = await import("../src/core/apps.js");
  const lsof = [
    "codex 66666 apple 1u IPv4 0x1 0t0 TCP 127.0.0.1:50123->127.0.0.1:7897 (ESTABLISHED)",
    "codex 66666 apple 2u IPv4 0x2 0t0 TCP 127.0.0.1:50124->127.0.0.1:52345 (ESTABLISHED)",
  ].join("\n");
  assert.deepEqual(parseProxyPorts(lsof, [66666]), [7897]);
});
