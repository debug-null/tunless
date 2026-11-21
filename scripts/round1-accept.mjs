#!/usr/bin/env node
// 安装包里的第一轮验收。只依赖本包的 src，不依赖 test 目录。
//
// 不会修改系统代理、launchctl、应用 settings，不会杀死或重启真实应用，
// 也不会读取代理凭据或配置正文。
//
// 用法（源码目录或 npm 安装后的包根都可以）：
//   node scripts/round1-accept.mjs
//   node scripts/round1-accept.mjs --live 127.0.0.1:7897

import net from "node:net";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const live = process.argv.find((arg, i) => process.argv[i - 1] === "--live");
const home = await mkdtemp(path.join(os.tmpdir(), "tunless-accept-"));
let failed = 0;

function say(line) {
  console.log(line);
}

function fail(name, detail) {
  failed += 1;
  say(`失败 ${name}：${detail}`);
}

say(`tunless ${pkg.version} 安装包验收`);
say(`包目录：${root}`);
say(`隔离 HOME：${home}`);
say("范围：临时高位端口上的假上游。不改系统代理，不碰真实应用。");

const { HttpProxyServer } = await import("../src/core/relay.js");

function once(port, payload, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    let acc = "";
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ text: acc, error: acc ? null : "超时，没有收到任何字节" });
    }, timeoutMs);
    socket.on("connect", () => socket.write(payload));
    socket.on("data", (chunk) => {
      acc += chunk.toString("latin1");
      if (acc.includes("\r\n\r\n")) {
        clearTimeout(timer);
        socket.destroy();
        resolve({ text: acc, error: null });
      }
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      resolve({ text: acc, error: err.code || err.message });
    });
  });
}

const silent = net.createServer((socket) => {
  socket.on("data", () => {});
  socket.on("error", () => {});
});
const closing = net.createServer((socket) => {
  socket.on("data", () => socket.destroy());
  socket.on("error", () => {});
});
await new Promise((resolve) => silent.listen(0, "127.0.0.1", resolve));
await new Promise((resolve) => closing.listen(0, "127.0.0.1", resolve));

const silentRelay = new HttpProxyServer({
  port: 0,
  host: "127.0.0.1",
  upstream: { host: "127.0.0.1", port: silent.address().port, protocols: ["http"] },
  handshakeTimeout: 250,
  log: () => {},
});
await silentRelay.start();
const started = Date.now();
const hung = await once(
  silentRelay.server.address().port,
  "GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n",
  1500,
);
const hungMs = Date.now() - started;
if (hung.error) fail("普通 HTTP 沉默", hung.error);
else if (!hung.text.startsWith("HTTP/1.1 504")) fail("普通 HTTP 沉默", `得到 ${hung.text.split("\r\n")[0] || "空"}`);
else if (hung.text.split("HTTP/1.1").length - 1 !== 1) fail("普通 HTTP 沉默", "写出了第二条状态行");
else if (hungMs >= 1000) fail("普通 HTTP 沉默", `用时 ${hungMs}ms，超过握手时限`);
else say(`通过 普通 HTTP 沉默 ${hungMs}ms → 504`);
await silentRelay.stop();
await new Promise((resolve) => silent.close(resolve));

const closingRelay = new HttpProxyServer({
  port: 0,
  host: "127.0.0.1",
  upstream: { host: "127.0.0.1", port: closing.address().port, protocols: ["http"] },
  handshakeTimeout: 250,
  log: () => {},
});
await closingRelay.start();
const closed = await once(
  closingRelay.server.address().port,
  "GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\n\r\n",
  1500,
);
if (closed.error) fail("普通 HTTP 提前断开", closed.error);
else if (!closed.text.startsWith("HTTP/1.1 502")) fail("普通 HTTP 提前断开", `得到 ${closed.text.split("\r\n")[0] || "空"}`);
else if (closed.text.split("HTTP/1.1").length - 1 !== 1) fail("普通 HTTP 提前断开", "写出了第二条状态行");
else say("通过 普通 HTTP 提前断开 → 502");
await closingRelay.stop();
await new Promise((resolve) => closing.close(resolve));

if (live) {
  say("");
  say(`只读探测 ${live}，公共目标 example.com:443，超时 5 秒`);
  try {
    const { probeProxy } = await import("../src/core/upstream.js");
    const [host, portText] = live.split(":");
    const port = Number(portText);
    const probed = await probeProxy(host, port, 1500);
    say(`协议：${probed.protocols.join("+") || "无免认证协议"}`);
    if (probed.authRequired.length) say(`需要认证：${probed.authRequired.join("+")}（本轮不代填，不当成可用）`);
    if (probed.protocols.includes("http")) {
      const socket = net.connect({ host, port });
      const status = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          socket.destroy();
          resolve("超时");
        }, 5000);
        socket.once("error", (err) => {
          clearTimeout(timer);
          resolve(err.code || err.message);
        });
        socket.once("connect", () => {
          socket.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
        });
        let buf = "";
        socket.on("data", (chunk) => {
          buf += chunk.toString("latin1");
          const line = buf.split("\r\n")[0];
          if (/^HTTP\/1\.[01] \d{3}/.test(line)) {
            clearTimeout(timer);
            socket.destroy();
            resolve(line);
          }
        });
      });
      say(`CONNECT example.com:443 → ${status}`);
      say("这一行只说明隧道握手，不说明账号、模型或地区可用。");
    } else {
      say("没有免认证 HTTP，跳过 CONNECT。不改你的上游。");
    }
  } catch (err) {
    fail("只读上游探测", err.stack || err.message);
  }
}

say("");
say("未覆盖：真实 AI 工具、配置写入确认、模型调用、macOS 系统代理。");
say("本脚本不安装 launchd，不改系统代理，不切换节点，不调用账号模型。");
await rm(home, { recursive: true, force: true }).catch((err) => {
  say(`清理 ${home} 失败：${err.message}`);
});
if (failed) {
  say(`验收失败 ${failed} 项`);
  process.exit(1);
}
say("验收通过");
