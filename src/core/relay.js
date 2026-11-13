// A tiny local forward proxy that hands proxy access to tools which cannot
// use the macOS system proxy, while keeping internal domains off the proxy.
//
// Routing decision:
//   internal host -> resolve through the internal DNS server, connect straight
//                    to the private address (never through the upstream proxy)
//   public host   -> forward the tunnel to the upstream mihomo mixed port
//
// The upstream is the running mihomo core; tunless reads its listener from the
// core API, so no proxy credentials or node names are ever handled here.

import net from "node:net";
import { queryA } from "./dns.js";
import { loadRules, matchHostRules, matchIpRules } from "./rules.js";

const CRLF = "\r\n";

export function normalizeHost(host) {
  return String(host || "")
    .toLowerCase()
    .replace(/^\[\]/, "")
    .replace(/^\*\./, "")
    .replace(/\.$/, "");
}

export function hostMatchesSuffix(host, suffix) {
  const h = normalizeHost(host);
  const s = normalizeHost(suffix).replace(/^\+\./, "");
  if (!h || !s) return false;
  return h === s || h.endsWith(`.${s}`);
}

export function decideRoute(host, { internalSuffixes = [] } = {}) {
  return internalSuffixes.some((suffix) => hostMatchesSuffix(host, suffix))
    ? "internal"
    : "upstream";
}

/**
 * 路由决策：先看自动扫描出来的后缀，再看用户手写的域名/关键词规则。
 * 用户规则优先，因为它存在的意义就是「自动没覆盖到」。
 */
export function decideRouteWithRules(host, { internalSuffixes = [], rules = null } = {}) {
  if (rules && matchHostRules(host, rules)) return "internal";
  return decideRoute(host, { internalSuffixes });
}

/**
 * 域名没命中任何规则、但解析出的 IP 落在用户填的网段里时，也算内网。
 * 这需要一次 DNS 查询，所以只在准备连上游之前做（失败就当公网）。
 */
export async function routeByIpRules(host, rules, internalDns, timeout = 1500) {
  if (!rules?.cidr?.length || !internalDns) return null;
  const res = await queryA(host, internalDns, { timeout });
  if (!res.ok || !res.ips.length) return null;
  for (const ip of res.ips) {
    const hit = matchIpRules(ip, rules);
    if (hit) return { ip, rule: hit };
  }
  return null;
}

export function splitHostPort(target, defaultPort) {
  const value = String(target || "").trim();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    const host = value.slice(1, end);
    const port = value.slice(end + 1).startsWith(":")
      ? Number(value.slice(end + 2))
      : defaultPort;
    return { host, port };
  }
  const idx = value.lastIndexOf(":");
  if (idx === -1) return { host: value, port: defaultPort };
  return { host: value.slice(0, idx), port: Number(value.slice(idx + 1)) || defaultPort };
}

export async function resolveInternal(host, internalDns, timeout = 3000) {
  if (!internalDns) return null;
  const res = await queryA(host, internalDns, { timeout });
  if (!res.ok || !res.ips.length) return null;
  // Prefer a private address; a fake-ip answer means the core still hijacks it.
  const privateIp = res.ips.find((ip) => !ip.startsWith("198.18."));
  return privateIp ?? null;
}

function readHead(socket, onHead) {
  let buffer = Buffer.alloc(0);
  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    const idx = buffer.indexOf("\r\n\r\n");
    if (idx === -1) {
      if (buffer.length > 64 * 1024) socket.destroy();
      return;
    }
    socket.off("data", onData);
    onHead(buffer.subarray(0, idx).toString("utf8"), buffer.subarray(idx + 4));
  };
  socket.on("data", onData);
}

function parseHead(text) {
  const lines = text.split(CRLF);
  const [method, target, version] = (lines.shift() || "").split(/\s+/);
  const headers = [];
  for (const line of lines) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    headers.push([line.slice(0, idx).trim(), line.slice(idx + 1).trim()]);
  }
  return { method, target, version, headers };
}

function rewriteHead(head, { method, path, host }) {
  const kept = head.headers.filter(([name]) => {
    const lower = name.toLowerCase();
    return lower !== "proxy-connection" && lower !== "proxy-authorization";
  });
  kept.push(["Host", host]);
  return [
    `${method} ${path} HTTP/1.1`,
    ...kept.map(([name, value]) => `${name}: ${value}`),
    "Connection: close",
    "",
    "",
  ].join(CRLF);
}


// Open a tunnel to the upstream mihomo mixed port. The upstream speaks SOCKS5
// too, but we already consumed the client's handshake, so we have to run our
// own against the upstream before piping the payload.
export async function openUpstreamSocks(upstream, host, port, timeout = 8000) {
  const socket = net.connect(upstream.port, upstream.host);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
    socket.setTimeout(timeout, () => reject(new Error("上游 SOCKS5 握手超时")));
  });
  socket.setTimeout(0);

  socket.write(Buffer.from([5, 1, 0]));
  const greeting = await readBytes(socket, 2);
  if (!greeting || greeting[0] !== 5 || greeting[1] !== 0) {
    socket.destroy();
    throw new Error("上游拒绝了 SOCKS5 握手");
  }

  const hostBuf = Buffer.from(normalizeHost(host), "utf8");
  const request = Buffer.concat([
    Buffer.from([5, 1, 0, 3, hostBuf.length]),
    hostBuf,
    (() => {
      const p = Buffer.alloc(2);
      p.writeUInt16BE(port);
      return p;
    })(),
  ]);
  socket.write(request);
  const head = await readBytes(socket, 4);
  if (!head) {
    socket.destroy();
    throw new Error("上游 SOCKS5 在请求期间关闭连接");
  }
  const reply = await readBytes(socket, head[3] === 1 ? 4 : head[3] === 4 ? 16 : 1);
  const portBuf = await readBytes(socket, 2);
  if (!head || head[1] !== 0) {
    socket.destroy();
    throw new Error(`上游 SOCKS5 拒绝 CONNECT（错误码 ${head?.[1]}）`);
  }
  void reply;
  void portBuf;
  return socket;
}

export class HttpProxyServer {
  constructor({
    port = 8899,
    host = "127.0.0.1",
    upstream = { host: "127.0.0.1", port: 7897 },
    internalDns = null,
    internalSuffixes = [],
    rules = null,
    log = () => {},
  } = {}) {
    this.port = port;
    this.host = host;
    this.upstream = upstream;
    this.internalDns = internalDns;
    this.internalSuffixes = internalSuffixes;
    this.rules = rules;
    this.log = log;
    this.server = null;
  }

  start() {
    this.server = net.createServer((socket) => this.handle(socket));
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => resolve(this));
    });
  }

  /**
   * 停止服务。
   *
   * 坑：net.Server.close() 只是「不再接受新连接」，
   * 已建立的连接不关掉，close 的回调就永远不触发。
   * 结果是一个挂着长连接的代理进程「停不下来」——
   * 守护进程收到 SIGTERM 后卡死在这里，端口也不会释放，
   * 表现为「关掉终端之后代理还在占着 8899，但新的连接进不来」。
   *
   * 所以这里要主动记住所有连接并逐个销毁。
   */
  stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      for (const socket of this.sockets ?? []) {
        try {
          socket.destroy();
        } catch {
          // 已经断了
        }
      }
      this.sockets?.clear();
      this.server.close(() => resolve());
      // 兜底：即使还有连接没断干净，也别把进程吊死
      setTimeout(resolve, 1000).unref?.();
    });
  }

  async handle(socket) {
    socket.setNoDelay(true);
    this.sockets ??= new Set();
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    readHead(socket, (text, rest) => {
      const head = parseHead(text);
      if (head.method === "CONNECT") {
        this.handleConnect(socket, head, rest);
      } else {
        this.handlePlain(socket, head, rest);
      }
    });
  }

  async handleConnect(socket, head, rest) {
    const { host, port } = splitHostPort(head.target, 443);
    let route = decideRouteWithRules(host, {
      internalSuffixes: this.internalSuffixes,
      rules: this.rules,
    });
    if (route === "upstream") {
      const byIp = await routeByIpRules(host, this.rules, this.internalDns);
      if (byIp) route = "internal";
    }
    this.log(`CONNECT ${host}:${port} -> ${route}`);

    if (route === "internal") {
      const ip = await resolveInternal(host, this.internalDns);
      if (!ip) {
        socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
        return;
      }
      const direct = net.connect(port, ip, () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        direct.write(rest ?? Buffer.alloc(0));
        socket.pipe(direct);
        direct.pipe(socket);
      });
      direct.on("error", (err) => {
        this.log(`CONNECT ${host}:${port} 直连失败：${err.message}`);
        socket.destroy();
      });
      socket.on("error", () => direct.destroy());
      return;
    }

    // Upstream route: replay the CONNECT request and forward the upstream's
    // own response verbatim — answering twice would break the client.
    const upstreamSocket = net.connect(this.upstream.port, this.upstream.host, () => {
      upstreamSocket.write(
        `${head.method} ${head.target} ${head.version || "HTTP/1.1"}\r\n${head.headers
          .map(([n, v]) => `${n}: ${v}`)
          .join("\r\n")}\r\n\r\n`,
      );
      readHead(upstreamSocket, (text) => {
        socket.write(`${text}\r\n\r\n`);
        upstreamSocket.write(rest ?? Buffer.alloc(0));
        socket.pipe(upstreamSocket);
        upstreamSocket.pipe(socket);
      });
    });
    upstreamSocket.on("error", (err) => {
      this.log(`CONNECT ${host}:${port} 上游失败：${err.message}`);
      socket.destroy();
    });
    socket.on("error", () => upstreamSocket.destroy());
  }

  async handlePlain(socket, head, rest) {
    let url;
    try {
      url = new URL(head.target);
    } catch {
      socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
      return;
    }
    if (url.protocol !== "http:") {
      socket.end("HTTP/1.1 501 Not Implemented\r\n\r\n");
      return;
    }
    const host = url.hostname;
    const port = Number(url.port || 80);
    let route = decideRouteWithRules(host, {
      internalSuffixes: this.internalSuffixes,
      rules: this.rules,
    });
    if (route === "upstream") {
      const byIp = await routeByIpRules(host, this.rules, this.internalDns);
      if (byIp) route = "internal";
    }
    this.log(`GET ${host}:${port} -> ${route}`);

    if (route === "upstream") {
      const upstreamSocket = net.connect(this.upstream.port, this.upstream.host, () => {
        upstreamSocket.write(
          `${head.method} ${head.target} HTTP/1.1\r\n${head.headers
            .map(([n, v]) => `${n}: ${v}`)
            .join("\r\n")}\r\n\r\n`,
        );
        upstreamSocket.write(rest ?? Buffer.alloc(0));
        socket.pipe(upstreamSocket);
        upstreamSocket.pipe(socket);
      });
      upstreamSocket.on("error", (err) => {
        this.log(`GET ${host}:${port} 上游失败：${err.message}`);
        socket.destroy();
      });
      socket.on("error", () => upstreamSocket.destroy());
      return;
    }

    const ip = await resolveInternal(host, this.internalDns);
    if (!ip) {
      socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
      return;
    }
    const targetSocket = net.connect(port, ip, () => {
      targetSocket.write(
        rewriteHead(head, {
          method: head.method,
          path: `${url.pathname}${url.search}`,
          host: url.host,
        }),
      );
      targetSocket.write(rest ?? Buffer.alloc(0));
      socket.pipe(targetSocket);
      targetSocket.pipe(socket);
    });
    targetSocket.on("error", () => socket.destroy());
    socket.on("error", () => targetSocket.destroy());
  }
}

export class Socks5Server {
  constructor({
    port = 8898,
    host = "127.0.0.1",
    upstream = { host: "127.0.0.1", port: 7897 },
    internalDns = null,
    internalSuffixes = [],
    rules = null,
    log = () => {},
  } = {}) {
    this.port = port;
    this.host = host;
    this.upstream = upstream;
    this.internalDns = internalDns;
    this.internalSuffixes = internalSuffixes;
    this.rules = rules;
    this.log = log;
    this.server = null;
  }

  start() {
    this.server = net.createServer((socket) => this.handle(socket));
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, () => resolve(this));
    });
  }

  /**
   * 停止服务。
   *
   * 坑：net.Server.close() 只是「不再接受新连接」，
   * 已建立的连接不关掉，close 的回调就永远不触发。
   * 结果是一个挂着长连接的代理进程「停不下来」——
   * 守护进程收到 SIGTERM 后卡死在这里，端口也不会释放，
   * 表现为「关掉终端之后代理还在占着 8899，但新的连接进不来」。
   *
   * 所以这里要主动记住所有连接并逐个销毁。
   */
  stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      for (const socket of this.sockets ?? []) {
        try {
          socket.destroy();
        } catch {
          // 已经断了
        }
      }
      this.sockets?.clear();
      this.server.close(() => resolve());
      // 兜底：即使还有连接没断干净，也别把进程吊死
      setTimeout(resolve, 1000).unref?.();
    });
  }

  async handle(socket) {
    socket.setNoDelay(true);
    this.sockets ??= new Set();
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
    const greeting = await readBytes(socket, 2);
    if (!greeting || greeting[0] !== 5) return socket.destroy();
    await readBytes(socket, greeting[1]);
    socket.write(Buffer.from([5, 0]));

    const header = await readBytes(socket, 4);
    if (!header || header[1] !== 1) {
      socket.write(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0]));
      return socket.destroy();
    }
    const { host, port } = await readAddress(socket, header[3]);
    let route = decideRouteWithRules(host, {
      internalSuffixes: this.internalSuffixes,
      rules: this.rules,
    });
    if (route === "upstream") {
      const byIp = await routeByIpRules(host, this.rules, this.internalDns);
      if (byIp) route = "internal";
    }
    this.log(`SOCKS5 CONNECT ${host}:${port} -> ${route}`);

    let upstreamSocket;
    try {
      if (route === "internal") {
        const ip = await resolveInternal(host, this.internalDns);
        if (!ip) {
          socket.write(Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0]));
          return socket.destroy();
        }
        upstreamSocket = net.connect(port, ip);
        await new Promise((resolve, reject) => {
          upstreamSocket.once("connect", resolve);
          upstreamSocket.once("error", reject);
        });
      } else {
        upstreamSocket = await openUpstreamSocks(this.upstream, host, port);
      }
    } catch (err) {
      this.log(`SOCKS5 ${host}:${port} 失败：${err.message}`);
      socket.write(Buffer.from([5, 1, 0, 1, 0, 0, 0, 0, 0, 0]));
      return socket.destroy();
    }

    releaseReader(socket);
    releaseReader(upstreamSocket);
    socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
    socket.pipe(upstreamSocket);
    upstreamSocket.pipe(socket);
    upstreamSocket.on("error", () => socket.destroy());
    socket.on("error", () => upstreamSocket.destroy());
  }
}

// Buffered reader: a single socket can deliver several protocol messages in
// one packet, so bytes beyond the requested count must be kept for the next
// read instead of being dropped.
function readerState(socket) {
  if (!socket.__tunlessReader) {
    const state = {
      buf: Buffer.alloc(0),
      waiters: [],
      onData: null,
      onEnd: null,
    };
    state.onData = (chunk) => {
      state.buf = Buffer.concat([state.buf, chunk]);
      flushReader(state);
    };
    state.onEnd = () => {
      for (const waiter of state.waiters.splice(0)) waiter.resolve(null);
    };
    socket.__tunlessReader = state;
    socket.on("data", state.onData);
    socket.on("end", state.onEnd);
    socket.on("error", state.onEnd);
    socket.on("close", state.onEnd);
  }
  return socket.__tunlessReader;
}

function flushReader(state) {
  while (state.waiters.length && state.buf.length >= state.waiters[0].count) {
    const waiter = state.waiters.shift();
    const data = state.buf.subarray(0, waiter.count);
    state.buf = state.buf.subarray(waiter.count);
    waiter.resolve(data);
  }
}

function readBytes(socket, count) {
  const state = readerState(socket);
  if (state.buf.length >= count) {
    const data = state.buf.subarray(0, count);
    state.buf = state.buf.subarray(count);
    return Promise.resolve(data);
  }
  return new Promise((resolve) => {
    state.waiters.push({ count, resolve });
  });
}

// Stop consuming data with the reader so the socket can be piped later.
function releaseReader(socket) {
  const state = socket.__tunlessReader;
  if (!state) return;
  socket.off("data", state.onData);
  socket.off("end", state.onEnd);
  socket.off("error", state.onEnd);
  socket.off("close", state.onEnd);
  socket.__tunlessReader = null;
  socket.pause();
}

async function readAddress(socket, atyp) {
  if (atyp === 1) {
    const buf = await readBytes(socket, 4);
    const portBuf = await readBytes(socket, 2);
    return {
      host: buf ? [...buf].join(".") : "",
      port: portBuf ? portBuf.readUInt16BE(0) : 0,
    };
  }
  if (atyp === 4) {
    const buf = await readBytes(socket, 16);
    const portBuf = await readBytes(socket, 2);
    const groups = [];
    for (let i = 0; i + 1 < (buf ? buf.length : 0); i += 2) {
      groups.push(buf.readUInt16BE(i).toString(16));
    }
    return {
      host: groups.join(":"),
      port: portBuf ? portBuf.readUInt16BE(0) : 0,
    };
  }
  const lenBuf = await readBytes(socket, 1);
  const len = lenBuf ? lenBuf[0] : 0;
  const hostBuf = await readBytes(socket, len);
  const portBuf = await readBytes(socket, 2);
  return {
    host: hostBuf ? hostBuf.toString("utf8") : "",
    port: portBuf ? portBuf.readUInt16BE(0) : 0,
  };
}
