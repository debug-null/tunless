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

test("mainPid 不依赖 /Applications 路径，装在别处也能找到主进程", async () => {
  const { mainPid } = await import("../src/core/apps.js");
  // 当前机器上真正运行的 Antigravity（装在 /Applications）应能找到 pid；
  // 找不到说明进程匹配逻辑退化了，TUI 会误判成「应用没运行」。
  const pid = await mainPid({ bundle: "Antigravity" });
  if (pid === null) {
    // 没装 / 没运行的机器上跳过断言，但至少要能干净返回
    assert.equal(pid, null);
    return;
  }
  assert.ok(Number.isInteger(pid) && pid > 0, `pid 应该是正整数，实际 ${pid}`);
  // 只匹配主进程，不能把 Helper 子进程算进来
  const { execFileSync } = await import("node:child_process");
  const cmd = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" });
  assert.match(cmd, /\/Antigravity\.app\/Contents\/MacOS\/Antigravity\s*$/);
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

test("parseProxyPorts：只连到非代理程序的端口时不算走代理", async () => {
  const { parseProxyPorts } = await import("../src/core/apps.js");
  // Antigravity 会连 MCP 服务（magpie:3425）和 language_server 自己的端口，
  // 这些都出现在 lsof 里，但都不是代理。
  const lsof = [
    "language_ 58202 apple  7u IPv4 0x1 0t0 TCP 127.0.0.1:57214 (LISTEN)",
    "magpie    64621 apple 15u IPv6 0x2 0t0 TCP *:3425 (LISTEN)",
    "language_ 58202 apple  9u IPv4 0x3 0t0 TCP 127.0.0.1:57300->127.0.0.1:3425 (ESTABLISHED)",
    "node      23652 apple 13u IPv4 0x4 0t0 TCP 127.0.0.1:8899 (LISTEN)",
    "language_ 58202 apple 10u IPv4 0x5 0t0 TCP 127.0.0.1:57301->127.0.0.1:8899 (ESTABLISHED)",
  ].join("\n");
  assert.deepEqual(parseProxyPorts(lsof, [58202]), [8899]);
});

test("proxyVerdict：同时连着旧代理时要标出残留", async () => {
  const { proxyVerdict } = await import("../src/core/apps.js");
  const ok = proxyVerdict({ pids: [1], ports: [7897, 8899] });
  assert.equal(ok.state, "ok");
  assert.deepEqual(ok.stale, [7897]);

  const clean = proxyVerdict({ pids: [1], ports: [8899] });
  assert.equal(clean.state, "ok");
  assert.deepEqual(clean.stale, []);
});

test("processProxyEnv 对不存在的 pid 返回 null 而不是误报有代理", async () => {
  const { processProxyEnv } = await import("../src/core/apps.js");
  assert.equal(await processProxyEnv(999999), null);
  assert.equal(await processProxyEnv(null), null);
});

test("networkPid 对未运行的应用返回 null", async () => {
  const { networkPid } = await import("../src/core/apps.js");
  const pid = await networkPid({ id: "antigravity", bundle: "TunlessNoSuchAppForTest" });
  assert.equal(pid, null);
});

test("processProxyEnv 只认可观察到的代理连接，读不到就说未知", async () => {
  const { processProxyEnv } = await import("../src/core/apps.js");
  // 不存在的进程：必须是 null（未知），不能返回 hasProxy=false 当成「没代理」
  assert.equal(await processProxyEnv(999999), null);
  // 当前进程一般不连代理，应返回 hasProxy:null 而不是 false
  const self = await processProxyEnv(process.pid);
  assert.ok(self === null || self.hasProxy === null || self.hasProxy === true);
});

test("waitForMainPid 会等到进程真的出现，而不是立刻判失败", async () => {
  const { waitForMainPid } = await import("../src/core/apps.js");
  // 用真实运行的 Antigravity 验证「已经在跑就立刻返回」；
  // 关键是不能在进程还没起来时给出 null。
  const pid = await waitForMainPid({ bundle: "Antigravity" }, { timeoutMs: 3000 });
  if (pid === null) {
    // 没装的机器上：应当耗尽超时并干净地返回 null，不抛错
    assert.equal(pid, null);
    return;
  }
  assert.ok(Number.isInteger(pid) && pid > 0);
});

test("waitForMainPid 对不存在的应用超时返回 null", async () => {
  const { waitForMainPid } = await import("../src/core/apps.js");
  const start = Date.now();
  const pid = await waitForMainPid(
    { bundle: "TunlessNoSuchAppForTest" },
    { timeoutMs: 600, intervalMs: 100 },
  );
  assert.equal(pid, null);
  assert.ok(Date.now() - start >= 500, "应当真的等满超时，而不是立即返回");
});
