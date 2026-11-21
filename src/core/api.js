import http from "node:http";

const DEFAULT_TIMEOUT = 8000;

export class MihomoApi {
  constructor({ host = "127.0.0.1", port = 9090, secret = "", socketPath = null, timeout = DEFAULT_TIMEOUT, signal = null } = {}) {
    this.host = host;
    this.port = port;
    this.secret = secret;
    this.socketPath = socketPath;
    this.timeout = timeout;
    this.signal = signal;
  }

  get descriptor() {
    return this.socketPath ? `unix://${this.socketPath}` : `http://${this.host}:${this.port}`;
  }

  request(method, path, body = null) {
    const options = {
      method,
      path,
      headers: { "Content-Type": "application/json" },
      timeout: this.timeout,
    };
    if (this.secret) options.headers.Authorization = `Bearer ${this.secret}`;
    if (this.socketPath) {
      options.socketPath = this.socketPath;
      options.host = "localhost";
      options.port = 80;
    } else {
      options.host = this.host;
      options.port = this.port;
    }

    const payload = body === null ? null : JSON.stringify(body);

    return new Promise((resolve, reject) => {
      if (this.signal?.aborted) {
        const err = new Error("检测已取消");
        err.name = "AbortError";
        reject(err);
        return;
      }
      const req = http.request(options, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (res.statusCode >= 400) {
            const err = new Error(`${method} ${path} 返回 HTTP ${res.statusCode}：${text.slice(0, 300)}`);
            err.statusCode = res.statusCode;
            err.body = text;
            return reject(err);
          }
          resolve({ status: res.statusCode, text });
        });
      });
      req.on("timeout", () => {
        req.destroy(new Error(`请求超时（${this.timeout}ms）：${method} ${path}`));
      });
      const abort = () => {
        const err = new Error("检测已取消");
        err.name = "AbortError";
        req.destroy(err);
      };
      if (this.signal) this.signal.addEventListener("abort", abort, { once: true });
      req.on("error", (err) => {
        if (this.signal) this.signal.removeEventListener("abort", abort);
        reject(err.name === "AbortError" || this.signal?.aborted ? Object.assign(err, { name: "AbortError" }) : err);
      });
      if (payload !== null) req.write(payload);
      req.end();
    });
  }

  async getJson(path) {
    const { text } = await this.request("GET", path);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`来自 ${path} 的 JSON 无法解析：${text.slice(0, 200)}`);
    }
  }

  async version() {
    return this.getJson("/version");
  }

  async configs() {
    return this.getJson("/configs");
  }

  async dnsQuery(name, type = "A") {
    return this.getJson(`/dns/query?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`);
  }

  async dnsAnswers(name, type = "A") {
    const data = await this.dnsQuery(name, type);
    return (data.Answer || []).filter((r) => r.type === 1).map((r) => r.data);
  }

  async reloadConfig(configPath, force = true) {
    await this.request("PUT", `/configs?force=${force}`, { path: configPath, payload: "" });
  }

  async patchConfig(patch) {
    await this.request("PATCH", "/configs", patch);
  }

  async proxies() {
    return (await this.getJson("/proxies")).proxies || {};
  }
}

/**
 * 并发探所有候选，第一个能回话的胜出。
 * 之前是串行：wmsxwd 之外再挂几个无效候选，每个都要等满 8s 超时，
 * 界面上就是「找内核」这一步卡二三十秒。
 */
export async function probeApi(candidates, { signal = null } = {}) {
  if (signal?.aborted) {
    const err = new Error("检测已取消");
    err.name = "AbortError";
    throw err;
  }
  if (!candidates?.length) {
    throw new Error("找不到可达的 mihomo 接口：没有候选地址");
  }
  const failures = [];
  return await new Promise((resolve, reject) => {
    let remaining = candidates.length;
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    if (signal) {
      signal.addEventListener(
        "abort",
        () => {
          const err = new Error("检测已取消");
          err.name = "AbortError";
          finish(reject, err);
        },
        { once: true },
      );
    }
    for (const candidate of candidates) {
      const api = new MihomoApi({ ...candidate, signal });
      api
        .version()
        .then((info) => finish(resolve, { api, info, candidate }))
        .catch((err) => {
          if (err.name === "AbortError" || signal?.aborted) {
            const abortErr = new Error("检测已取消");
            abortErr.name = "AbortError";
            finish(reject, abortErr);
            return;
          }
          failures.push({ candidate, error: err.message });
          remaining -= 1;
          if (remaining === 0) {
            const detail = failures
              .map((f) => `  - ${new MihomoApi(f.candidate).descriptor}: ${f.error}`)
              .join("\n");
            const error = new Error(`找不到可达的 mihomo 接口：\n${detail}`);
            error.failures = failures;
            finish(reject, error);
          }
        });
    }
  });
}
