// 连通性检测：转发服务在跑，不等于外网真的通。
//
// 这里直接以 HTTP 代理的身份发一个 CONNECT 隧道，验证
// 「127.0.0.1:8899 → 外网」这条路是通的。不用 fetch，因为
// fetch 不认 HTTP_PROXY 环境变量，必须自己走代理协议。

import net from "node:net";
import tls from "node:tls";

const DEFAULT_TARGET = "github.com";

/**
 * @returns {Promise<{ok: boolean, detail: string, ms: number}>}
 */
export function checkReachability({
  host = "127.0.0.1",
  port = 8899,
  target = DEFAULT_TARGET,
  timeoutMs = 8000,
} = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;

    const socket = net.connect({ host, port });

    const finish = (ok, detail) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // 已经断了
      }
      resolve({ ok, detail, ms: Date.now() - started });
    };

    socket.setTimeout(timeoutMs, () =>
      finish(false, `代理端口 ${host}:${port} 无响应`),
    );
    socket.once("error", (err) =>
      finish(false, `代理端口 ${host}:${port} 连不上：${err.code ?? err.message}`),
    );

    socket.once("connect", () => {
      socket.write(
        `CONNECT ${target}:443 HTTP/1.1\r\nHost: ${target}:443\r\nUser-Agent: tunless\r\n\r\n`,
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
          { socket, servername: target, rejectUnauthorized: false },
          () => {
            secure.write(
              `GET / HTTP/1.1\r\nHost: ${target}\r\nUser-Agent: tunless\r\nConnection: close\r\n\r\n`,
            );
          },
        );
        secure.setTimeout(timeoutMs, () => finish(false, "隧道建立后没有收到响应"));
        secure.on("error", (err) => finish(false, `隧道建立后失败：${err.message}`));

        let resp = "";
        secure.on("data", (chunk) => {
          resp += chunk.toString("latin1");
          const headEnd = resp.indexOf("\r\n\r\n");
          if (headEnd === -1) return;
          const code =
            Number(/^HTTP\/1\.\d (\d+)/.exec(resp.slice(0, headEnd))?.[1] ?? 0);
          finish(code > 0 && code < 500, `${target} 经代理返回 ${code}`);
        });
      };
      socket.on("data", onData);
    });
  });
}
