#!/usr/bin/env node
// 第一轮验收脚本。默认只跑合成代理，监听临时端口。
//
// 不会修改系统代理、launchctl、应用 settings，不会杀死或重启真实应用，
// 也不会读取代理凭据或配置正文。
//
// 用法：
//   node scripts/round1-accept.mjs
//   node scripts/round1-accept.mjs --live 127.0.0.1:7897
//
// --live 只对已经在听的本地上游做只读协议探测，并向 example.com:443 发一条 CONNECT。
// 输出状态码，不输出响应正文。超时 5 秒。失败只说明这一次探测，不切换节点。

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const live = process.argv.find((arg, i) => process.argv[i - 1] === "--live");

const home = await mkdtemp(path.join(os.tmpdir(), "tunless-accept-"));
const started = Date.now();
let failed = false;

function say(line) {
  console.log(line);
}

say("tunless 第一轮合成验收");
say(`隔离 HOME：${home}`);
say("范围：临时端口上的假代理。不改系统代理，不碰真实应用。");

const child = execFile(
  process.execPath,
  ["--test", "--test-concurrency=1", "test/round1-regressions.test.js"],
  {
    cwd: root,
    env: { ...process.env, HOME: home },
    timeout: 60_000,
  },
);
let output = "";
child.stdout?.on("data", (chunk) => {
  output += chunk;
});
child.stderr?.on("data", (chunk) => {
  output += chunk;
});
const code = await new Promise((resolve) => {
  child.on("close", resolve);
  child.on("error", () => resolve(1));
});
const summary = output.match(/# (pass|fail) \d+/g)?.join("，") ?? "没有测试汇总";
say(`合成测试退出码 ${code}，${summary}，用时 ${Date.now() - started}ms`);
if (code !== 0) {
  failed = true;
  const fails = output.split("\n").filter((line) => line.startsWith("not ok ")).slice(0, 12);
  for (const line of fails) say(line);
}

if (live) {
  say("");
  say(`只读探测 ${live}，公共目标 example.com:443，超时 5 秒`);
  const { probeProxy } = await import("../src/core/upstream.js");
  const [host, portText] = live.split(":");
  const port = Number(portText);
  const probed = await probeProxy(host, port, 1500);
  say(`协议：${probed.protocols.join("+") || "无免认证协议"}`);
  if (probed.authRequired.length) say(`需要认证：${probed.authRequired.join("+")}（本轮不代填，不当成可用）`);
  if (probed.protocols.includes("http")) {
    const status = await new Promise((resolve) => {
      const socket = net.connect({ host, port });
      const timer = setTimeout(() => {
        socket.destroy();
        resolve("超时");
      }, 5000);
      socket.once("error", (err) => {
        clearTimeout(timer);
        resolve(err.code || "连接失败");
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
}

say("");
say("macOS 上仍须你另行授权的事项（本脚本不会做）：");
say("  - 安装或重启 tunless 的 launchd 服务");
say("  - 修改系统代理、launchctl setenv、Cursor/Antigravity settings");
say("  - 退出或重启 Cursor、Antigravity 或其他真实应用");
say("  - 切换代理节点，或用账号调用模型");
say("回滚：脚本只占用临时目录和临时端口，进程结束即释放。");
say(`清理：rm -rf ${home}`);

await rm(home, { recursive: true, force: true }).catch(() => {});
if (failed) process.exit(1);
