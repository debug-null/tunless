import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideRoute,
  decideRouteWithRules,
  hostMatchesSuffix,
  splitHostPort,
  normalizeHost,
  rewriteHead,
} from "../src/core/relay.js";

const suffixes = ["17usoft.com", "cdb.17usoft.com", "17u.cn"];

test("hostMatchesSuffix matches a domain and its subdomains", () => {
  assert.ok(hostMatchesSuffix("matrix.17usoft.com", "17usoft.com"));
  assert.ok(hostMatchesSuffix("17usoft.com", "17usoft.com"));
  assert.ok(hostMatchesSuffix("a.b.17usoft.com", "17usoft.com"));
  assert.ok(hostMatchesSuffix("cn-north.database-mysql.qa.cdb.17usoft.com", "cdb.17usoft.com"));
});

test("hostMatchesSuffix does not match unrelated or partial domains", () => {
  assert.ok(!hostMatchesSuffix("not17usoft.com", "17usoft.com"));
  assert.ok(!hostMatchesSuffix("17usoft.com.evil.net", "17usoft.com"));
  assert.ok(!hostMatchesSuffix("github.com", "17usoft.com"));
});

test("hostMatchesSuffix understands the +. wildcard form", () => {
  assert.ok(hostMatchesSuffix("matrix.17usoft.com", "+.17usoft.com"));
});

test("decideRoute sends internal domains direct and the rest upstream", () => {
  assert.equal(decideRoute("matrix.17usoft.com", { internalSuffixes: suffixes }), "internal");
  assert.equal(decideRoute("wiki.17u.cn", { internalSuffixes: suffixes }), "internal");
  assert.equal(decideRoute("github.com", { internalSuffixes: suffixes }), "upstream");
});

test("splitHostPort parses host:port, bracketed IPv6 and defaults", () => {
  assert.deepEqual(splitHostPort("example.com:443", 80), { host: "example.com", port: 443 });
  assert.deepEqual(splitHostPort("example.com", 80), { host: "example.com", port: 80 });
  assert.deepEqual(splitHostPort("[::1]:8080", 80), { host: "::1", port: 8080 });
});

test("normalizeHost lowercases and strips wildcard/root dots", () => {
  assert.equal(normalizeHost("Matrix.17usoft.com."), "matrix.17usoft.com");
  assert.equal(normalizeHost("*.example.com"), "example.com");
});

test("用户手写的域名规则优先于自动扫描的后缀", () => {
  const rules = { domain: ["example.com"], keyword: ["jira"], cidr: [] };
  assert.equal(decideRouteWithRules("matrix.example.com", { internalSuffixes: [], rules }), "internal");
  assert.equal(decideRouteWithRules("jira.corp.com", { internalSuffixes: [], rules }), "internal");
  assert.equal(decideRouteWithRules("github.com", { internalSuffixes: [], rules }), "upstream");
});

test("没有规则时行为与原来一致", () => {
  assert.equal(decideRouteWithRules("matrix.17usoft.com", { internalSuffixes: suffixes }), "internal");
  assert.equal(decideRouteWithRules("github.com", { internalSuffixes: suffixes }), "upstream");
  assert.equal(decideRouteWithRules("github.com", { internalSuffixes: suffixes, rules: null }), "upstream");
});

// 回归：有活跃长连接时 stop() 必须能立刻返回。
// 之前 net.Server.close() 的回调要等所有连接断开才触发，
// 守护进程收到 SIGTERM 会卡死在这，端口不释放，
// 表现就是「关了终端之后代理还在但连不上」。
test("有活跃连接时 stop() 也能立刻停掉", async () => {
  const net = await import("node:net");
  const { HttpProxyServer } = await import("../src/core/relay.js");

  const port = 18901;
  const server = new HttpProxyServer({ port, log: () => {} });
  await server.start();

  // 建一条连接但不说完整请求头，模拟挂着的长连接
  const held = net.connect(port, "127.0.0.1");
  await new Promise((resolve) => held.once("connect", resolve));

  const started = Date.now();
  await Promise.race([
    server.stop(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("stop() 超过 2 秒还没返回，说明又被长连接吊住了")), 2000),
    ),
  ]);
  const elapsed = Date.now() - started;

  assert.ok(elapsed < 1000, `stop() 用了 ${elapsed}ms，太久`);

  // 端口应该已经释放
  await assert.rejects(
    new Promise((resolve, reject) => {
      const probe = net.connect(port, "127.0.0.1");
      probe.once("connect", () => {
        probe.destroy();
        resolve();
      });
      probe.once("error", reject);
    }),
    "端口没释放，还能连上",
  );
  held.destroy();
});

// 上游只支持 HTTP 代理（Surge / Stash / Privoxy）时，CONNECT 也必须能通。
// 以前这里写死 SOCKS5，这类用户整条链路全废。
test("上游只有 HTTP 代理时 CONNECT 依然能用", async () => {
  const netmod = await import("node:net");
  const { HttpProxyServer } = await import("../src/core/relay.js");

  const track = (server) => {
    const sockets = new Set();
    server.on("connection", (s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
    });
    server.closeAll = () => {
      for (const s of sockets) s.destroy();
      return new Promise((resolve) => server.close(resolve));
    };
    return server;
  };

  // 本地目标服务：收到数据就回一句，用来验证隧道是双向通的
  const echo = track(
    netmod.createServer((socket) => {
      socket.on("data", () => socket.write("hello-from-target"));
      socket.on("error", () => {});
    }),
  );
  await new Promise((resolve) => echo.listen(0, "127.0.0.1", resolve));
  const targetPort = echo.address().port;

  // 假的上游 HTTP 代理：只实现 CONNECT，隧道接到本地 echo。
  // 只处理一次握手，同一条连接后续的数据交给管道。
  const proxy = track(
    netmod.createServer((socket) => {
      let head = "";
      const onData = (chunk) => {
        head += chunk.toString("latin1");
        if (!head.includes("\r\n\r\n")) return;
        socket.off("data", onData);
        const rest = Buffer.from(head.slice(head.indexOf("\r\n\r\n") + 4), "latin1");
        const target = netmod.connect(targetPort, "127.0.0.1", () => {
          socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
          if (rest.length) target.write(rest);
          socket.pipe(target);
          target.pipe(socket);
        });
        target.on("error", () => socket.destroy());
        socket.on("error", () => target.destroy());
      };
      socket.on("data", onData);
      socket.on("error", () => {});
    }),
  );
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = proxy.address().port;

  const relay = new HttpProxyServer({
    port: 18902,
    upstream: { host: "127.0.0.1", port: proxyPort, protocols: ["http"] },
    log: () => {},
  });
  await relay.start();

  const payload = await new Promise((resolve) => {
    const socket = netmod.connect(18902, "127.0.0.1");
    let stage = 0;
    let buf = "";
    socket.on("connect", () => {
      socket.write("CONNECT local.test:80 HTTP/1.1\r\nHost: local.test:80\r\n\r\n");
    });
    socket.on("data", (chunk) => {
      if (stage === 0) {
        buf += chunk.toString("latin1");
        if (!buf.includes("\r\n\r\n")) return;
        stage = 1;
        socket.write("ping");
        return;
      }
      socket.destroy();
      resolve(chunk.toString());
    });
    socket.on("error", (err) => resolve(`error: ${err.code}`));
  });

  assert.equal(payload, "hello-from-target");
  await relay.stop();
  await proxy.closeAll();
  await echo.closeAll();
});

// 回归：rewriteHead 之前保留原始 Host 又无条件加一个，
// 报文里出现两个 Host 头，严格的源站直接 400。
test("rewriteHead 只产生一个 Host 头", () => {
  const head = {
    headers: [
      ["Host", "old.example.com:80"],
      ["User-Agent", "curl/8"],
      ["Proxy-Connection", "keep-alive"],
      ["Proxy-Authorization", "Basic x"],
      ["Accept", "*/*"],
    ],
  };
  const out = rewriteHead(head, {
    method: "GET",
    path: "/a?b=1",
    host: "new.example.com:8080",
  });
  const hostLines = out.split("\r\n").filter((l) => /^host:/i.test(l));
  assert.equal(hostLines.length, 1);
  assert.equal(hostLines[0], "Host: new.example.com:8080");
  assert.ok(!out.includes("Proxy-Connection"));
  assert.ok(!out.includes("Proxy-Authorization"));
  assert.ok(out.includes("User-Agent: curl/8"));
});

// 回归：上游把握手应答和首个隧道数据打进同一个 TCP 段时，
// 之前会把跟随的字节丢掉，客户端一直等不到响应。
test("CONNECT 通道不丢上游应答后紧跟的字节", async () => {
  const netmod = await import("node:net");
  const { HttpProxyServer } = await import("../src/core/relay.js");

  const sockets = new Set();
  const track = (server) => {
    server.on("connection", (s) => {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
    });
    return server;
  };
  const closeAll = (server) =>
    new Promise((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(resolve);
    });

  // 假上游 HTTP 代理：CONNECT 应答和「提前到达的隧道数据」一次写出。
  const proxy = track(
    netmod.createServer((socket) => {
      socket.once("data", () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n" + "EARLY-BYTES");
        socket.on("data", () => {});
      });
      socket.on("error", () => {});
    }),
  );
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyPort = proxy.address().port;

  const relay = new HttpProxyServer({
    port: 18903,
    upstream: { host: "127.0.0.1", port: proxyPort, protocols: ["socks5-not-really"] },
    internalDns: null,
    log: () => {},
  });
  // 绕过协议选择，直接验证 socks 路径的 early 转发：
  // protocols 不含 http 时走 openUpstreamSocks —— 这里用 HTTP 协议的 fake
  // 上游不行，所以换成直接测试 openUpstreamHttp。
  const { openUpstreamHttp } = await import("../src/core/relay.js");
  const tunnel = await openUpstreamHttp(
    { host: "127.0.0.1", port: proxyPort },
    "anything.test",
    443,
  );
  assert.ok(tunnel.early?.length > 0, "握手包后面的字节没有被保留");
  assert.equal(tunnel.early.toString("latin1"), "EARLY-BYTES");
  tunnel.destroy();

  await relay.stop().catch(() => {});
  await closeAll(proxy);
});

// socks5 上游同理：SOCKS 应答后紧跟的隧道数据必须进 socket.early。
test("SOCKS5 握手后的早到字节不丢", async () => {
  const netmod = await import("node:net");
  const { openUpstreamSocks } = await import("../src/core/relay.js");

  const sockets = new Set();
  const fake = netmod.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    let stage = 0;
    socket.on("data", () => {
      if (stage === 0) {
        stage = 1;
        socket.write(Buffer.from([5, 0]));
      } else if (stage === 1) {
        stage = 2;
        // SOCKS5 CONNECT 应答 + 同一包里紧跟隧道数据
        const reply = Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
        socket.write(Buffer.concat([reply, Buffer.from("SNEAKY")]));
      }
    });
    socket.on("error", () => {});
  });
  await new Promise((resolve) => fake.listen(0, "127.0.0.1", resolve));

  const tunnel = await openUpstreamSocks(
    { host: "127.0.0.1", port: fake.address().port },
    "example.test",
    443,
  );
  assert.equal(tunnel.early?.toString("latin1"), "SNEAKY");
  tunnel.destroy();
  for (const s of sockets) s.destroy();
  await new Promise((resolve) => fake.close(resolve));
});
