// 连通性检测：转发服务在跑，不等于外网真的通。
//
// 这里直接以 HTTP 代理的身份发一个 CONNECT 隧道，验证
// 「127.0.0.1:8899 → 外网」这条路是通的。不用 fetch，因为
// fetch 不认 HTTP_PROXY 环境变量，必须自己走代理协议。

import net from "node:net";
import tls from "node:tls";

/**
 * 经本地转发代理访问一个目标。
 *
 * `ok` 的判定是「服务器真的回了 HTTP」—— 不是 200。
 * 这很重要：`oauth2.googleapis.com/token` 用 GET 打过去必然不是 200，
 * 但能收到 404/400 就说明隧道通了、TLS 握手完成了、对端活着。
 * 一律要求 200 会把「其实能用」误判成坏掉。
 *
 * @returns {Promise<{ok: boolean, detail: string, status: number|null, ms: number}>}
 */
export function checkReachability({
  host = "127.0.0.1",
  port = 8899,
  target = "github.com",
  targetPort = 443,
  targetPath = "/",
  timeoutMs = 8000,
} = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    // 硬超时。
    // 不能只靠 socket.setTimeout / tlsSocket.setTimeout：前者在有数据流过时
    // 会被不断重置，后者在 TLS 还没握手完成时根本不会开始计时。
    // 结果是「CONNECT 成功但 TLS 握手卡住」时整个调用永远不返回，
    // 界面就一直停在「正在测…」。
    const deadline = setTimeout(
      () => finish(false, `${target} 超时（${timeoutMs}ms 内没有完成握手）`),
      timeoutMs + 1000,
    );

    const socket = net.connect({ host, port });

    const finish = (ok, detail, status = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      try {
        socket.destroy();
      } catch {
        // 已经断了
      }
      resolve({ ok, detail, status, ms: Date.now() - started });
    };

    socket.setTimeout(timeoutMs, () =>
      finish(false, `代理端口 ${host}:${port} 无响应`),
    );
    socket.once("error", (err) =>
      finish(false, `代理端口 ${host}:${port} 连不上：${err.code ?? err.message}`),
    );

    socket.once("connect", () => {
      socket.write(
        `CONNECT ${target}:${targetPort} HTTP/1.1\r\nHost: ${target}:${targetPort}\r\nUser-Agent: tunless\r\n\r\n`,
      );

      let buf = "";
      const onData = (chunk) => {
        buf += chunk.toString("latin1");
        const end = buf.indexOf("\r\n\r\n");
        if (end === -1) return;
        socket.off("data", onData);

        const status = Number(
          /^HTTP\/1\.\d (\d+)/.exec(buf.slice(0, end))?.[1] ?? 0,
        );
        if (status !== 200) {
          finish(false, `代理拒绝了隧道（HTTP ${status || "无状态码"}）`);
          return;
        }

        const secure = tls.connect(
          {
            socket,
            servername: target,
            rejectUnauthorized: false,
            // 必须显式只谈 http/1.1。
            // 有些站点（agentn.global.api5.cursor.sh 就是）默认协商成 h2，
            // 然后在隧道里回二进制帧。我们按 HTTP/1.1 解析文本，
            // 结果一个字节都对不上，只能干等到超时 —— 明明链路是通的。
            ALPNProtocols: ["http/1.1"],
          },
          () => {
            secure.write(
              `GET ${targetPath || "/"} HTTP/1.1\r\nHost: ${target}\r\nUser-Agent: tunless\r\nConnection: close\r\n\r\n`,
            );
          },
        );
        secure.setTimeout(timeoutMs, () => finish(false, "隧道建立后没有收到响应"));
        secure.on("error", (err) => finish(false, `隧道建立后失败：${err.message}`));

        let resp = "";
        secure.on("data", (chunk) => {
          resp += chunk.toString("latin1");
          const headEnd = resp.indexOf("\r\n\r\n");
          if (headEnd === -1) {
            // 有些端点是纯 gRPC，无视 ALPN 直接回 HTTP/2 二进制帧
            // （agentn.global.api5.cursor.sh 就是这样）。它永远不会给出
            // HTTP/1.1 头部，但我们确实完成了 TLS 握手、也收到了对端数据，
            // 这已经证明「经代理能到达对端」—— 判成失败是误报。
            if (looksLikeHttp2(resp)) {
              finish(true, `${target} 可达（HTTP/2 端点）`, null);
            }
            return;
          }
          const code =
            Number(/^HTTP\/1\.\d (\d+)/.exec(resp.slice(0, headEnd))?.[1] ?? 0);
          // 4xx 也算通：说明请求真的到了对端，只是这个 URL 不接受 GET。
          finish(code > 0 && code < 500, `${target} 返回 ${code}`, code || null);
        });
      };
      socket.on("data", onData);
    });
  });
}

/**
 * 判断收到的是不是 HTTP/2 帧。
 * h2 帧头是 3 字节长度 + 1 字节类型 + 1 字节 flags + 4 字节流 ID；
 * 第一个字节通常很小（帧长 < 16KB），最后一字节的最低位是流 ID 的起始位。
 * HTTP/1.1 文本一定以 "HTTP/" 开头，所以先排除它。
 */
export function looksLikeHttp2(buf) {
  if (!buf || buf.length < 9) return false;
  if (buf.startsWith("HTTP/")) return false;
  const first = buf.charCodeAt(0);
  // 文本首字节都是可打印字符（H=72 等），h2 帧长首字节通常是小控制字符
  return first < 0x20 || first === 0x7f;
}

/**
 * 依次测多个目标。任一失败不算整体失败 —— 但界面上要能分别看到，
 * 因为「登录接口不通」和「模型接口不通」是两种完全不同的故障。
 */
export async function checkTargets({
  host = "127.0.0.1",
  port = 8899,
  targets = [],
  timeoutMs = 8000,
} = {}) {
  const results = [];
  for (const target of targets) {
    const res = await checkReachability({
      host,
      port,
      target: target.host,
      targetPort: target.port ?? 443,
      targetPath: target.path ?? "/",
      timeoutMs,
    });
    results.push({ ...target, ...res });
  }
  return summarizeResults(results);
}

/**
 * 把逐个目标的结果汇总成一个结论。
 *
 * 必测目标全通才算通；标了 optional 的只展示结果、不参与判定 ——
 * 否则像 api5.cursor.sh 这种本身就常坏的备用域名会把整体误判成失败。
 */
export function summarizeResults(results) {
  const required = results.filter((r) => !r.optional);
  const ok = required.length > 0 && required.every((r) => r.ok);
  return {
    ok,
    results,
    failedRequired: required.filter((r) => !r.ok),
    failedOptional: results.filter((r) => !r.ok && r.optional),
  };
}
