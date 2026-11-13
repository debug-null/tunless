import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideRoute,
  decideRouteWithRules,
  hostMatchesSuffix,
  splitHostPort,
  normalizeHost,
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
