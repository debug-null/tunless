import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";

const certDir = fs.mkdtempSync(path.join(os.tmpdir(), "tunless-round1-"));
const certPath = path.join(certDir, "cert.pem");
const keyPath = path.join(certDir, "key.pem");
execFileSync(
  "openssl",
  ["req", "-x509", "-newkey", "rsa:2048", "-keyout", keyPath, "-out", certPath, "-days", "1", "-nodes", "-subj", "/CN=local.test"],
  { stdio: "ignore" },
);
const cert = fs.readFileSync(certPath);
const key = fs.readFileSync(keyPath);

function track(server) {
  const sockets = new Set();
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.on("error", () => {});
  });
  server.sockets = sockets;
  return server;
}
function listen(server, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve(server.address().port));
  });
}
async function shutdown(server) {
  if (!server) return;
  for (const s of server.sockets ?? []) s.destroy();
  await new Promise((resolve) => server.close(resolve));
}

test("407 与 SOCKS 用户名认证只标记需要认证，不能当免认证上游", async () => {
  const { probeProxy, pickUpstream } = await import("../src/core/upstream.js");
  const http407 = track(net.createServer((socket) => {
    socket.once("data", () => {
      socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm=\"x\"\r\nContent-Length: 0\r\n\r\n");
    });
  }));
  const socksAuth = track(net.createServer((socket) => {
    socket.once("data", (buf) => {
      const n = buf[1] ?? 0;
      const methods = [...buf.subarray(2, 2 + n)];
      socket.end(Buffer.from([5, methods.includes(2) ? 2 : 0xff]));
    });
  }));
  const httpPort = await listen(http407);
  const socksPort = await listen(socksAuth);
  try {
    const http = await probeProxy("127.0.0.1", httpPort, 800);
    assert.deepEqual(http.protocols, []);
    assert.deepEqual(http.authRequired, ["http"]);
    const socks = await probeProxy("127.0.0.1", socksPort, 800);
    assert.deepEqual(socks.protocols, []);
    assert.deepEqual(socks.authRequired, ["socks5"]);
    const chosen = pickUpstream([
      { host: "127.0.0.1", port: httpPort, protocols: http.protocols, authRequired: http.authRequired, usable: false },
      { host: "127.0.0.1", port: 1, protocols: ["http"], authRequired: [], usable: true },
    ]);
    assert.equal(chosen.port, 1);
  } finally {
    await shutdown(http407);
    await shutdown(socksAuth);
  }
});

test("命令行指定的上游按探测结果选协议，不写死 http+socks5", async () => {
  const { resolveUpstream } = await import("../src/cli.js");
  const httpOnly = track(net.createServer((socket) => {
    socket.once("data", () => socket.end("HTTP/1.1 200 Connection Established\r\n\r\n"));
  }));
  const port = await listen(httpOnly);
  try {
    const result = await resolveUpstream({ flags: { upstream: `127.0.0.1:${port}` } });
    assert.deepEqual(result.upstream.protocols, ["http"]);
  } finally {
    await shutdown(httpOnly);
  }
});

test("只要求认证的 --upstream 不返回可用上游", async () => {
  const { resolveUpstream } = await import("../src/cli.js");
  const http407 = track(net.createServer((socket) => {
    socket.once("data", () => {
      socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n");
    });
  }));
  const port = await listen(http407);
  try {
    const result = await resolveUpstream({ flags: { upstream: `127.0.0.1:${port}` } });
    assert.equal(result.upstream, null);
    assert.match(result.detail, /需要认证/);
    assert.deepEqual(result.authRequired, ["http"]);
  } finally {
    await shutdown(http407);
  }
});

test("同一客户端的 HTTP 与 SOCKS 端口不算上游漂移", async () => {
  const { detectPinnedDrift } = await import("../src/core/upstream.js");
  const drift = await detectPinnedDrift({
    pinned: { host: "127.0.0.1", port: 7897, systemProxyPort: 7897 },
    systemProxy: [
      { host: "127.0.0.1", port: 7897, label: "系统代理（HTTP）" },
      { host: "127.0.0.1", port: 7891, label: "系统代理（SOCKS）" },
    ],
    probe: async () => ["socks5"],
  });
  assert.equal(drift.stale, false);
});

test("客户端半关闭后仍能收到上游在 FIN 之后的响应", async () => {
  const { HttpProxyServer } = await import("../src/core/relay.js");
  const echo = track(net.createServer({ allowHalfOpen: true }, (socket) => {
    const chunks = [];
    socket.on("data", (c) => chunks.push(c));
    socket.on("end", () => socket.end(`after-fin:${Buffer.concat(chunks).toString()}`));
  }));
  const echoPort = await listen(echo);
  const proxy = track(net.createServer({ allowHalfOpen: true }, (socket) => {
    let buf = Buffer.alloc(0);
    socket.on("data", (c) => {
      buf = Buffer.concat([buf, c]);
      const idx = buf.indexOf("\r\n\r\n");
      if (idx < 0) return;
      socket.removeAllListeners("data");
      const rest = buf.subarray(idx + 4);
      const target = net.connect(echoPort, "127.0.0.1");
      target.on("connect", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length) target.write(rest);
        socket.pipe(target);
        target.pipe(socket);
      });
    });
  }));
  const proxyPort = await listen(proxy);
  const relay = new HttpProxyServer({
    port: 0,
    upstream: { host: "127.0.0.1", port: proxyPort, protocols: ["http"] },
    log: () => {},
  });
  await relay.start();
  try {
    const got = await new Promise((resolve) => {
      const s = net.connect(relay.server.address().port, "127.0.0.1");
      let acc = Buffer.alloc(0);
      const timer = setTimeout(() => { s.destroy(); resolve(acc.toString("latin1")); }, 1200);
      s.on("connect", () => s.write("CONNECT half.test:80 HTTP/1.1\r\nHost: half.test:80\r\n\r\n"));
      s.on("data", (c) => {
        acc = Buffer.concat([acc, c]);
        if (acc.includes("\r\n\r\n") && !s.sent) {
          s.sent = true;
          s.write("ping");
          s.end();
        }
      });
      s.on("close", () => { clearTimeout(timer); resolve(acc.toString("latin1")); });
      s.on("error", () => { clearTimeout(timer); resolve(acc.toString("latin1")); });
    });
    assert.match(got, /after-fin:ping/);
  } finally {
    await relay.stop();
    await shutdown(proxy);
    await shutdown(echo);
  }
});

test("上游握手沉默或提前关闭时在 deadline 内结束，不无限挂起", async () => {
  const { HttpProxyServer } = await import("../src/core/relay.js");
  const silent = track(net.createServer(() => {}));
  const closing = track(net.createServer((socket) => {
    socket.on("data", () => socket.end());
  }));
  const silentPort = await listen(silent);
  const closingPort = await listen(closing);
  const run = async (upstreamPort) => {
    const relay = new HttpProxyServer({
      port: 0,
      handshakeTimeout: 300,
      upstream: { host: "127.0.0.1", port: upstreamPort, protocols: ["http"] },
      log: () => {},
    });
    await relay.start();
    try {
      const started = Date.now();
      const body = await new Promise((resolve) => {
        const s = net.connect(relay.server.address().port, "127.0.0.1");
        let acc = "";
        const timer = setTimeout(() => { s.destroy(); resolve(acc); }, 1000);
        s.on("connect", () => s.write("CONNECT hang.test:443 HTTP/1.1\r\nHost: hang.test:443\r\n\r\n"));
        s.on("data", (c) => { acc += c.toString("latin1"); });
        s.on("close", () => { clearTimeout(timer); resolve(acc); });
        s.on("error", () => { clearTimeout(timer); resolve(acc); });
      });
      return { ms: Date.now() - started, body };
    } finally {
      await relay.stop();
    }
  };
  try {
    const a = await run(silentPort);
    const b = await run(closingPort);
    assert.match(a.body, /50[24]/);
    assert.match(b.body, /50[24]/);
    assert.ok(a.ms < 900 && b.ms < 900, JSON.stringify({ a, b }));
  } finally {
    await shutdown(silent);
    await shutdown(closing);
  }
});

test("客户端关闭时直连套接字一起关掉", async () => {
  const { HttpProxyServer } = await import("../src/core/relay.js");
  const dns = await startDns({ "hold.example": [127, 0, 0, 1] });
  let held = null;
  const target = track(net.createServer((socket) => { held = socket; }));
  const targetPort = await listen(target);
  const relay = new HttpProxyServer({
    port: 0,
    upstream: { host: "127.0.0.1", port: 1, protocols: ["http"] },
    internalDns: "127.0.0.1",
    internalDnsPort: dns.port,
    internalSuffixes: ["example"],
    log: () => {},
  });
  await relay.start();
  try {
    await new Promise((resolve) => {
      const s = net.connect(relay.server.address().port, "127.0.0.1");
      let acc = "";
      s.on("connect", () => s.write(`CONNECT hold.example:${targetPort} HTTP/1.1\r\nHost: hold.example:${targetPort}\r\n\r\n`));
      s.on("data", (c) => {
        acc += c.toString("latin1");
        if (acc.includes("\r\n\r\n")) s.destroy();
      });
      s.on("close", () => resolve());
      setTimeout(() => { s.destroy(); resolve(); }, 1000);
    });
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(held, "直连没有建立");
    assert.equal(held.destroyed || held.closed, true);
  } finally {
    await relay.stop();
    await shutdown(target);
    dns.close();
  }
});

test("内网后缀的公网答复和 DNS 失败默认拒绝，不发给上游", async () => {
  const { planInternalConnect, HttpProxyServer } = await import("../src/core/relay.js");
  assert.equal(typeof planInternalConnect, "function");
  const pub = planInternalConnect(["203.0.113.9"], { ok: true, fallback: "refuse" });
  assert.equal(pub.action, "refuse");
  assert.equal(pub.reason, "public-answer");
  const fake = planInternalConnect(["198.18.0.5"], { ok: true, fallback: "refuse" });
  assert.equal(fake.action, "refuse");
  assert.equal(fake.reason, "fake-ip");
  const missing = planInternalConnect([], { ok: false, fallback: "refuse" });
  assert.equal(missing.action, "refuse");
  assert.equal(missing.reason, "dns-failed");
  const direct = planInternalConnect(["10.1.2.3"], { ok: true, fallback: "refuse" });
  assert.equal(direct.action, "direct");
  assert.equal(direct.ip, "10.1.2.3");
  const opted = planInternalConnect(["203.0.113.9"], { ok: true, fallback: "upstream" });
  assert.equal(opted.action, "upstream");
  assert.equal(opted.leak, true);

  const dns = await startDns({
    "public.example": [203, 0, 113, 9],
    "nx.example": null,
  });
  let hits = 0;
  const proxy = track(net.createServer((socket) => {
    hits += 1;
    socket.once("data", (c) => {
      socket.seen = c.toString("latin1");
      socket.end("HTTP/1.1 200 Connection Established\r\n\r\n");
    });
  }));
  const proxyPort = await listen(proxy);
  const relay = new HttpProxyServer({
    port: 0,
    upstream: { host: "127.0.0.1", port: proxyPort, protocols: ["http"] },
    internalDns: "127.0.0.1",
    internalDnsPort: dns.port,
    internalDnsTimeout: 400,
    internalSuffixes: ["example"],
    internalFallback: "refuse",
    log: () => {},
  });
  await relay.start();
  try {
    const status = await connectOnce(relay.server.address().port, "CONNECT public.example:443 HTTP/1.1\r\nHost: public.example:443\r\n\r\n");
    assert.match(status, /^HTTP\/1\.1 502/);
    assert.equal(hits, 0);
    const nx = await connectOnce(relay.server.address().port, "CONNECT nx.example:443 HTTP/1.1\r\nHost: nx.example:443\r\n\r\n");
    assert.match(nx, /^HTTP\/1\.1 502/);
    assert.equal(hits, 0);
  } finally {
    await relay.stop();
    await shutdown(proxy);
    dns.close();
  }
});

test("显式 internalFallback=upstream 才把解析失败的内网名发给上游", async () => {
  const { HttpProxyServer, planInternalConnect } = await import("../src/core/relay.js");
  assert.equal(typeof planInternalConnect, "function");
  assert.equal(planInternalConnect(["203.0.113.9"], { ok: true, fallback: "upstream" }).action, "upstream");
  const dns = await startDns({ "public.example": [203, 0, 113, 9] });
  let seen = "";
  const proxy = track(net.createServer((socket) => {
    socket.once("data", (c) => {
      seen += c.toString("latin1");
      socket.end("HTTP/1.1 200 Connection Established\r\n\r\n");
    });
  }));
  const proxyPort = await listen(proxy);
  const relay = new HttpProxyServer({
    port: 0,
    upstream: { host: "127.0.0.1", port: proxyPort, protocols: ["http"] },
    internalDns: "127.0.0.1",
    internalDnsPort: dns.port,
    internalSuffixes: ["example"],
    internalFallback: "upstream",
    log: () => {},
  });
  await relay.start();
  try {
    const status = await connectOnce(relay.server.address().port, "CONNECT public.example:443 HTTP/1.1\r\nHost: public.example:443\r\n\r\n", 1000);
    assert.match(status, /200/);
    assert.match(seen, /CONNECT public\.example:443/);
  } finally {
    await relay.stop();
    await shutdown(proxy);
    dns.close();
  }
});

test("应用连接观察认 ::1 和 Surge/AtlasCore，不把 node 开发端口当代理", async () => {
  const { parseProxyConnections } = await import("../src/core/apps.js");
  const lsof = [
    "Surge 1 user 3u IPv4 0x1 0t0 TCP *:6152 (LISTEN)",
    "AtlasCore 2 user 4u IPv4 0x1 0t0 TCP *:6478 (LISTEN)",
    "node 3 user 5u IPv4 0x1 0t0 TCP 127.0.0.1:3000 (LISTEN)",
    "Cursor 9 user 10u IPv4 0x1 0t0 TCP 127.0.0.1:50000->127.0.0.1:6152 (ESTABLISHED)",
    "Cursor 9 user 11u IPv4 0x1 0t0 TCP 127.0.0.1:50001->127.0.0.1:6478 (ESTABLISHED)",
    "Cursor 9 user 12u IPv4 0x1 0t0 TCP 127.0.0.1:50002->127.0.0.1:3000 (ESTABLISHED)",
    "Cursor 9 user 13u IPv6 0x1 0t0 TCP [::1]:50003->[::1]:8899 (ESTABLISHED)",
    "Cursor 9 user 14u IPv4 0x1 0t0 TCP 127.0.0.1:50004->127.0.0.1:7897 (ESTABLISHED)",
  ].join("\n");
  const parsed = parseProxyConnections(lsof, [9]);
  assert.deepEqual(parsed.ports, [6152, 6478, 7897, 8899]);
});

test("出口样本认 HTTP 状态和编码，缓存按目标分开，429 不是国家", async () => {
  const { detectEgress, _resetEgressCache } = await import("../src/core/egress.js");
  const mode = { value: "hk" };
  const proxy = track(tlsProxy((target) => {
    if (mode.value === "chunked") return chunked(200, { ip: "1.1.1.1", country: "SG" });
    if (mode.value === "gzip") return gzipResponse(200, { ip: "2.2.2.2", country: "DE" });
    if (mode.value === "denied") return textResponse(429, { ip: "9.9.9.9", country: "US" });
    if (target.startsWith("example.com")) return textResponse(200, { ip: "3.3.3.3", country: "SG" });
    return textResponse(200, { ip: "8.8.8.8", country: "HK" });
  }));
  const port = await listen(proxy);
  const upstream = { host: "127.0.0.1", port, protocols: ["http"] };
  try {
    _resetEgressCache();
    const hk = await detectEgress(upstream, { timeoutMs: 2000, rejectUnauthorized: false });
    assert.equal(hk?.country, "HK");
    const sg = await detectEgress(upstream, { timeoutMs: 2000, target: "example.com", path: "/json", rejectUnauthorized: false });
    assert.equal(sg?.country, "SG");
    mode.value = "chunked";
    _resetEgressCache();
    const chunk = await detectEgress(upstream, { timeoutMs: 2000, target: "chunk.test", path: "/json", rejectUnauthorized: false });
    assert.equal(chunk?.country, "SG");
    mode.value = "gzip";
    _resetEgressCache();
    const gz = await detectEgress(upstream, { timeoutMs: 2000, target: "gzip.test", path: "/json", rejectUnauthorized: false });
    assert.equal(gz?.country, "DE");
    mode.value = "denied";
    _resetEgressCache();
    const denied = await detectEgress(upstream, { timeoutMs: 2000, target: "denied.test", path: "/json", rejectUnauthorized: false });
    assert.equal(denied, null);
  } finally {
    await shutdown(proxy);
  }
});

test("401/403/429 保留状态且服务未验证，假 HTTP/2 字节不算成功", async () => {
  const { checkReachability, looksLikeHttp2 } = await import("../src/core/reach.js");
  assert.equal(looksLikeHttp2("\u0000".repeat(9)), false);
  const proxy = track(tlsProxy((target) => {
    if (target.startsWith("nul.test")) return { raw: Buffer.alloc(9) };
    const code = target.startsWith("auth.test") ? 401 : target.startsWith("quota.test") ? 429 : 403;
    return textResponse(code, { error: "no" });
  }));
  const port = await listen(proxy);
  try {
    const forbidden = await checkReachability({ port, target: "forbid.test", timeoutMs: 2000 });
    assert.equal(forbidden.httpStatus, 403);
    assert.equal(forbidden.serviceVerified, false);
    assert.equal(forbidden.tunnelOk, true);
    const auth = await checkReachability({ port, target: "auth.test", timeoutMs: 2000 });
    assert.equal(auth.httpStatus, 401);
    assert.equal(auth.serviceVerified, false);
    const quota = await checkReachability({ port, target: "quota.test", timeoutMs: 2000 });
    assert.equal(quota.httpStatus, 429);
    assert.equal(quota.serviceVerified, false);
    const nul = await checkReachability({ port, target: "nul.test", timeoutMs: 600 });
    assert.equal(nul.ok, false);
    assert.equal(nul.serviceVerified, false);
  } finally {
    await shutdown(proxy);
  }
});

function connectOnce(port, payload, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const s = net.connect(port, "127.0.0.1");
    let acc = "";
    const timer = setTimeout(() => { s.destroy(); resolve(acc || "timeout"); }, timeoutMs);
    s.on("connect", () => s.write(payload));
    s.on("data", (c) => {
      acc += c.toString("latin1");
      if (acc.includes("\r\n\r\n")) {
        clearTimeout(timer);
        s.destroy();
        resolve(acc);
      }
    });
    s.on("error", () => { clearTimeout(timer); resolve(acc || "error"); });
  });
}

function startDns(records) {
  const sock = dgram.createSocket("udp4");
  sock.on("message", (msg, rinfo) => {
    const name = decodeDnsName(msg);
    const ip = records[name];
    sock.send(dnsAnswer(msg, ip === undefined ? false : ip), rinfo.port, rinfo.address);
  });
  return new Promise((resolve) => {
    sock.bind(0, "127.0.0.1", () => {
      resolve({ port: sock.address().port, close: () => sock.close() });
    });
  });
}
function decodeDnsName(msg) {
  let off = 12;
  const labels = [];
  while (off < msg.length && msg[off] !== 0) {
    const len = msg[off];
    labels.push(msg.subarray(off + 1, off + 1 + len).toString("ascii"));
    off += len + 1;
  }
  return labels.join(".");
}
function dnsAnswer(query, ip) {
  if (!ip) {
    const res = Buffer.from(query);
    res.writeUInt16BE(0x8183, 2);
    res.writeUInt16BE(0, 6);
    return res;
  }
  const res = Buffer.alloc(query.length + 16);
  query.copy(res);
  res.writeUInt16BE(0x8180, 2);
  res.writeUInt16BE(1, 6);
  const a = res.subarray(query.length);
  a.writeUInt16BE(0xc00c, 0);
  a.writeUInt16BE(1, 2);
  a.writeUInt16BE(1, 4);
  a.writeUInt32BE(30, 6);
  a.writeUInt16BE(4, 10);
  a.set(ip, 12);
  return res;
}

function textResponse(status, json) {
  const body = JSON.stringify(json);
  return {
    raw: Buffer.from(
      `HTTP/1.1 ${status} X\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      "utf8",
    ),
  };
}
function chunked(status, json) {
  const body = JSON.stringify(json);
  const n = Buffer.byteLength(body).toString(16);
  return {
    raw: Buffer.from(
      `HTTP/1.1 ${status} X\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${n}\r\n${body}\r\n0\r\n\r\n`,
      "utf8",
    ),
  };
}
function gzipResponse(status, json) {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(json)));
  const head = Buffer.from(
    `HTTP/1.1 ${status} X\r\nContent-Encoding: gzip\r\nContent-Length: ${gz.length}\r\nConnection: close\r\n\r\n`,
    "utf8",
  );
  return { raw: Buffer.concat([head, gz]) };
}

function tlsProxy(handler) {
  return net.createServer((socket) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf("\r\n\r\n");
      if (idx < 0) return;
      socket.off("data", onData);
      const head = buf.subarray(0, idx).toString("latin1");
      const rest = buf.subarray(idx + 4);
      const target = /^CONNECT (\S+)/.exec(head)?.[1] ?? "";
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (rest.length) socket.unshift(rest);
      const secure = new tls.TLSSocket(socket, { isServer: true, cert, key });
      secure.on("error", () => {});
      let req = Buffer.alloc(0);
      secure.on("data", (c) => {
        req = Buffer.concat([req, c]);
        if (!req.includes(Buffer.from("\r\n\r\n"))) return;
        const res = handler(target);
        secure.end(res.raw);
      });
    };
    socket.on("data", onData);
    socket.on("error", () => {});
  });
}
