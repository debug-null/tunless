import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  parseListening,
  parseUpstream,
  labelForProcess,
  probeProtocols,
  verifyUpstream,
} from "../src/core/upstream.js";

test("parseListening 保留回环与通配绑定，丢掉局域网地址", () => {
  const lsof = [
    "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME",
    "mihomo 1234 apple 5u IPv4 0x1 0t0 TCP 127.0.0.1:7897 (LISTEN)",
    "nginx  99   apple 6u IPv4 0x2 0t0 TCP *:8080 (LISTEN)",
    "node   77   apple 7u IPv4 0x3 0t0 TCP 192.168.1.5:9000 (LISTEN)",
    "node   78   apple 8u IPv6 0x4 0t0 TCP [::1]:1080 (LISTEN)",
  ].join("\n");

  const rows = parseListening(lsof, {
    commands: new Map([
      [1234, "/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo"],
    ]),
  });
  assert.deepEqual(
    rows.map((r) => r.port),
    // *:8080 现在会保留：wmsxwd 的 AtlasCore 就是 *:6478，
    // 当成「局域网端口」丢掉的话，用户一关系统代理就再也认不出它。
    // 是不是代理交给后面的协议实测判断。
    [7897, 8080, 1080],
  );
  assert.equal(rows[0].process.includes("Clash Verge"), true);
  assert.equal(rows[1].host, "127.0.0.1");
  assert.equal(rows[1].wildcard, true);
  assert.equal(rows[1].bound, "*");
  assert.equal(rows[2].wildcard, false);
});

test("parseUpstream 接受 host:port 与裸端口", () => {
  assert.deepEqual(parseUpstream("127.0.0.1:7897"), { host: "127.0.0.1", port: 7897 });
  assert.deepEqual(parseUpstream("7897"), { host: "127.0.0.1", port: 7897 });
  assert.deepEqual(parseUpstream("192.168.1.2:1080"), { host: "192.168.1.2", port: 1080 });
  assert.equal(parseUpstream("abc"), null);
  assert.equal(parseUpstream(""), null);
  assert.equal(parseUpstream("127.0.0.1:0"), null);
});

test("labelForProcess 认出常见客户端", () => {
  assert.equal(
    labelForProcess("/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo"),
    "Clash Verge Rev",
  );
  assert.equal(labelForProcess("/Applications/Surge.app/Contents/MacOS/Surge"), "Surge");
  assert.equal(labelForProcess("/opt/homebrew/bin/sing-box"), "sing-box");
  assert.equal(labelForProcess("/usr/sbin/nginx"), null);
});

function socks5Server() {
  return net.createServer((socket) => {
    socket.once("data", () => socket.write(Buffer.from([5, 0])));
    socket.on("error", () => {});
  });
}

function httpProxyServer(status = 200) {
  return net.createServer((socket) => {
    socket.once("data", () => socket.write(`HTTP/1.1 ${status} OK\r\n\r\n`));
    socket.on("error", () => {});
  });
}

function plainTcpServer() {
  return net.createServer((socket) => {
    socket.write("SSH-2.0-OpenSSH\r\n");
    socket.on("error", () => {});
  });
}

async function withServer(server, fn) {
  const sockets = new Set();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(port);
  } finally {
    // 服务端可能还留着探测用的连接，不主动断掉 close 的回调永远不会触发
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("probeProtocols 认出 SOCKS5 端口", async () => {
  const server = socks5Server();
  await withServer(server, async (port) => {
    const protocols = await probeProtocols("127.0.0.1", port, 500);
    assert.deepEqual(protocols, ["socks5"]);
  });
});

test("probeProtocols 认出 HTTP 代理端口", async () => {
  const server = httpProxyServer(200);
  await withServer(server, async (port) => {
    const protocols = await probeProtocols("127.0.0.1", port, 500);
    assert.deepEqual(protocols, ["http"]);
  });
});

test("probeProtocols 对非代理端口返回空数组", async () => {
  const server = plainTcpServer();
  await withServer(server, async (port) => {
    const protocols = await probeProtocols("127.0.0.1", port, 500);
    assert.deepEqual(protocols, []);
  });
});

test("verifyUpstream 对 HTTP 代理做真实 CONNECT 校验", async () => {
  const server = httpProxyServer(200);
  await withServer(server, async (port) => {
    const result = await verifyUpstream({
      host: "127.0.0.1",
      port,
      protocols: ["http"],
    });
    assert.equal(result.ok, true);
  });
});

test("verifyUpstream 把 403 判成不可用，而不是「端口在监听就算通」", async () => {
  const server = httpProxyServer(403);
  await withServer(server, async (port) => {
    const result = await verifyUpstream({
      host: "127.0.0.1",
      port,
      protocols: ["http"],
    });
    assert.equal(result.ok, false);
    assert.match(result.detail, /403/);
  });
});

test("verifyUpstream 没有上游时给出说明而不是抛错", async () => {
  const result = await verifyUpstream(null);
  assert.equal(result.ok, false);
  assert.match(result.detail, /没有可用/);
});

test("looksLikeClashConfig 不会把客户端 UI 设置当成内核配置", async () => {
  const { looksLikeClashConfig } = await import("../src/core/discover.js");
  // mihomo-party 的 config.yaml 长这样：只有 UI 偏好，没有端口
  const uiSettings = [
    "core: mihomo",
    "enableSmartCore: true",
    "appTheme: system",
    "useWindowFrame: false",
    "maxLogDays: 7",
  ].join("\n");
  assert.equal(looksLikeClashConfig(uiSettings), false);
  assert.equal(looksLikeClashConfig(""), false);

  const kernel = ["mixed-port: 7890", "external-controller: 127.0.0.1:9090"].join("\n");
  assert.equal(looksLikeClashConfig(kernel), true);
});

test("labelForProcess 认得 wmsxwd 的 AtlasCore 内核", () => {
  assert.equal(
    labelForProcess("/Applications/wmsxwd.app/Contents/Resources/AtlasCore_arm64"),
    "wmsxwd",
  );
  assert.equal(
    labelForProcess("/Library/Application Support/clash-verge-service/cores/verge-mihomo"),
    "Clash Verge Rev",
  );
});

test("detectPinnedDrift：端口还活着但客户端换了，要认出来", async () => {
  const { detectPinnedDrift } = await import("../src/core/upstream.js");
  const pinned = { host: "127.0.0.1", port: 7897 };
  const systemProxy = [{ host: "127.0.0.1", port: 6478, label: "系统代理" }];

  const drift = await detectPinnedDrift({
    pinned,
    systemProxy,
    probe: async () => ["socks5", "http"],
  });
  assert.equal(drift.stale, true);
  assert.equal(drift.replacement.port, 6478);
  assert.match(drift.reason, /7897/);
  assert.match(drift.reason, /6478/);
});

test("detectPinnedDrift：固定的端口就是系统代理时不算漂移", async () => {
  const { detectPinnedDrift } = await import("../src/core/upstream.js");
  const drift = await detectPinnedDrift({
    pinned: { host: "127.0.0.1", port: 6478 },
    systemProxy: [{ host: "127.0.0.1", port: 6478 }],
    probe: async () => ["socks5", "http"],
  });
  assert.equal(drift.stale, false);
});

test("detectPinnedDrift：系统代理指向的端口不是代理时不算漂移", async () => {
  const { detectPinnedDrift } = await import("../src/core/upstream.js");
  const drift = await detectPinnedDrift({
    pinned: { host: "127.0.0.1", port: 7897 },
    systemProxy: [{ host: "127.0.0.1", port: 8080 }],
    probe: async () => [],
  });
  assert.equal(drift.stale, false);
});

test("detectPinnedDrift：钉住时系统代理就是现在这个端口 → 用户是故意的，不动它", async () => {
  const { detectPinnedDrift } = await import("../src/core/upstream.js");
  const drift = await detectPinnedDrift({
    // 用户明知道系统代理在 6478，却故意钉了 7897
    pinned: { host: "127.0.0.1", port: 7897, systemProxyPort: 6478 },
    systemProxy: [{ host: "127.0.0.1", port: 6478 }],
    probe: async () => ["socks5", "http"],
  });
  assert.equal(drift.stale, false);
});

test("detectPinnedDrift：钉住之后系统代理换端口 → 算过期", async () => {
  const { detectPinnedDrift } = await import("../src/core/upstream.js");
  const drift = await detectPinnedDrift({
    pinned: { host: "127.0.0.1", port: 7897, systemProxyPort: 7897 },
    systemProxy: [{ host: "127.0.0.1", port: 6478 }],
    probe: async () => ["socks5", "http"],
  });
  assert.equal(drift.stale, true);
  assert.equal(drift.replacement.port, 6478);
});

test("probeHttp 不把 403 的本地服务当成代理（AirPlay 7000/5000 就是这样）", async () => {
  const server = net.createServer((socket) => {
    socket.on("data", () => {
      socket.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nServer: AirTunes/1005\r\n\r\n");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    assert.deepEqual(await probeProtocols("127.0.0.1", port, 800), []);
  } finally {
    server.close();
  }
});

test("probeHttp 认得回 200 Connection established 的代理", async () => {
  const server = net.createServer((socket) => {
    socket.on("data", () => {
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    assert.deepEqual(await probeProtocols("127.0.0.1", port, 800), ["http"]);
  } finally {
    server.close();
  }
});

test("probeSocks5 遇到只吐 banner 的服务不会卡死", async () => {
  // ssh 端口就是这种：先吐一段自己的 banner，然后一直安静地挂着。
  // 光靠 socket 的空闲超时收不了尾，探测会永远挂着。
  const server = net.createServer((socket) => {
    socket.write("SSH-2.0-OpenSSH_9.0\r\n");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    const result = await Promise.race([
      probeProtocols("127.0.0.1", port, 400),
      new Promise((r) => setTimeout(() => r(["TIMEOUT"]), 3000)),
    ]);
    assert.deepEqual(result, []);
  } finally {
    server.close();
  }
});
