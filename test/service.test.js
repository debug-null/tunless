import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { sidecarReachable, plistXml, LABEL } from "../src/core/launchd.js";

test("plist 里的 Label 与 launchd 查询用的一致", () => {
  const xml = plistXml({
    program: "/usr/bin/node",
    args: ["/tmp/tunless.js", "proxy"],
    outLog: "/tmp/out.log",
    errLog: "/tmp/err.log",
  });
  assert.match(xml, new RegExp(`<string>${LABEL}</string>`));
  assert.match(xml, /<string>\/usr\/bin\/node<\/string>/);
  assert.match(xml, /<string>\/tmp\/tunless\.js<\/string>/);
});

test("sidecarReachable 对监听中的端口返回 true", async () => {
  const server = net.createServer((socket) => socket.end());
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  assert.equal(await sidecarReachable("127.0.0.1", port), true);
  await new Promise((resolve) => server.close(resolve));
});

test("sidecarReachable 对未监听端口返回 false 而不是抛错", async () => {
  // 先占一个端口拿到确定空闲的端口号，再关掉它
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await sidecarReachable("127.0.0.1", port, 500), false);
});
