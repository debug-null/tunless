import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTarget,
  targetsForApp,
  APP_TARGETS,
  DEFAULT_TARGETS,
} from "../src/core/targets.js";

test("parseTarget 接受裸域名、带端口、带路径、带协议", () => {
  assert.deepEqual(parseTarget("api.example.com"), {
    host: "api.example.com",
    port: 443,
    path: "/",
    label: "手动添加",
  });
  assert.deepEqual(parseTarget("api.example.com:8443"), {
    host: "api.example.com",
    port: 8443,
    path: "/",
    label: "手动添加",
  });
  assert.deepEqual(parseTarget("https://api.example.com/health"), {
    host: "api.example.com",
    port: 443,
    path: "/health",
    label: "手动添加",
  });
  assert.deepEqual(parseTarget("10.1.2.3:8080/ping"), {
    host: "10.1.2.3",
    port: 8080,
    path: "/ping",
    label: "手动添加",
  });
});

test("parseTarget 拒绝空值和明显不是地址的输入", () => {
  assert.equal(parseTarget(""), null);
  assert.equal(parseTarget("   "), null);
  // 带空格的中文句子不该被当成域名去连
  assert.equal(parseTarget("帮我测一下外网"), null);
  assert.equal(parseTarget("http://"), null);
});

test("targetsForApp 给出该应用真正会连的域名", () => {
  const antigravity = targetsForApp("antigravity").map((t) => t.host);
  // 这是用户真实报错里的域名：Post https://oauth2.googleapis.com/token
  assert.ok(antigravity.includes("oauth2.googleapis.com"));
  assert.ok(antigravity.includes("daily-cloudcode-pa.googleapis.com"));

  const cursor = targetsForApp("cursor").map((t) => t.host);
  assert.ok(cursor.includes("api2.cursor.sh"));

  const codex = targetsForApp("codex").map((t) => t.host);
  assert.ok(codex.includes("chatgpt.com"));
});

test("targetsForApp 对未知应用回落到通用目标", () => {
  assert.deepEqual(targetsForApp("something-else"), DEFAULT_TARGETS);
  assert.deepEqual(targetsForApp(undefined), DEFAULT_TARGETS);
});

test("每个应用的目标都不是空的，且都带端口和路径", () => {
  for (const [appId, list] of Object.entries(APP_TARGETS)) {
    assert.ok(list.length > 0, `${appId} 没有测试目标`);
    for (const t of list) {
      assert.ok(t.host, `${appId} 有目标缺 host`);
      assert.equal(typeof t.port, "number");
      assert.ok(t.path.startsWith("/"), `${appId} 的 ${t.host} 路径不合法`);
    }
  }
});

test("可选目标失败不算整体失败", async () => {
  const { summarizeResults } = await import("../src/core/reach.js");

  const mixed = summarizeResults([
    { host: "api2.cursor.sh", ok: true },
    { host: "api5.cursor.sh", ok: false, optional: true },
  ]);
  assert.equal(mixed.ok, true);
  assert.equal(mixed.failedOptional.length, 1);
  assert.equal(mixed.failedRequired.length, 0);

  const broken = summarizeResults([
    { host: "api2.cursor.sh", ok: false },
    { host: "api5.cursor.sh", ok: false, optional: true },
  ]);
  assert.equal(broken.ok, false);
  assert.deepEqual(broken.failedRequired.map((r) => r.host), ["api2.cursor.sh"]);
});

test("全是可选目标或没有目标时不算通过", async () => {
  const { summarizeResults } = await import("../src/core/reach.js");
  assert.equal(summarizeResults([]).ok, false);
  assert.equal(summarizeResults([{ host: "x.com", ok: true, optional: true }]).ok, false);
});

test("looksLikeHttp2 认出 h2 帧，不把 HTTP/1.1 误判", async () => {
  const { looksLikeHttp2 } = await import("../src/core/reach.js");

  // 真实的 HTTP/2 SETTINGS 帧（长度 6，类型 4，flags 0，stream 0）
  const settings = Buffer.from([0, 0, 6, 4, 0, 0, 0, 0, 0, 4, 8, 0, 0, 0, 0]).toString("latin1");
  assert.equal(looksLikeHttp2(settings), true);

  // HTTP/1.1 文本永远以 HTTP/ 开头，哪怕后面跟着二进制
  assert.equal(looksLikeHttp2("HTTP/1.1 200 OK\r\n\r\n"), false);
  assert.equal(looksLikeHttp2("HTTP/1.0 404 Not Found"), false);

  // 太短的数据不做判断
  assert.equal(looksLikeHttp2(""), false);
  assert.equal(looksLikeHttp2("\x00\x00\x06\x04"), false);
});

test("checkReachability 对「CONNECT 成功但隧道不回数据」有硬超时", async () => {
  const net = await import("node:net");
  const { checkReachability } = await import("../src/core/reach.js");

  // 接受 CONNECT 后什么都不回的代理：这正是之前会让界面永远卡住的情形
  const server = net.createServer((socket) => {
    socket.once("data", () => socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"));
    socket.on("error", () => {});
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const started = Date.now();
  const result = await checkReachability({
    port,
    target: "stall.example",
    timeoutMs: 800,
  });
  const elapsed = Date.now() - started;

  assert.equal(result.ok, false);
  // 必须真的返回，而不是挂着；留一点余量给硬超时的 1 秒缓冲
  assert.ok(elapsed < 4000, `用了 ${elapsed}ms，超时没生效`);

  for (const socket of server.__sockets ?? []) socket.destroy();
  await new Promise((r) => server.close(r));
});

test("removeCustomTarget 不写端口时删掉该主机的所有端口", async () => {
  const { addCustomTarget, removeCustomTarget, loadCustomTargets } = await import(
    "../src/core/targets.js"
  );
  const { dataDir } = await import("../src/core/paths.js");
  const fs = await import("node:fs");
  const path = await import("node:path");

  // 这个用例真的会写 ~/.tunless/targets.json，测完还原
  const file = path.join(dataDir(), "targets.json");
  const backup = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  try {
    fs.rmSync(file, { force: true });
    addCustomTarget({ host: "a.example.com", port: 443, path: "/" });
    addCustomTarget({ host: "a.example.com", port: 8443, path: "/health" });
    addCustomTarget({ host: "b.example.com", port: 443, path: "/" });
    assert.equal(loadCustomTargets().length, 3);

    // 不写端口：这个主机的两条都删
    const { removed } = removeCustomTarget("a.example.com");
    assert.equal(removed, true);
    assert.deepEqual(loadCustomTargets().map((t) => t.host), ["b.example.com"]);

    // 写了端口：只删那一条
    addCustomTarget({ host: "a.example.com", port: 8443, path: "/" });
    removeCustomTarget("a.example.com", 8443);
    assert.deepEqual(loadCustomTargets().map((t) => t.host), ["b.example.com"]);
  } finally {
    if (backup === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, backup);
  }
});
