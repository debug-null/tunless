import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

test("取消内核探测会拆掉未完成请求，下一轮不会和它重叠", async () => {
  const { probeApi } = await import("../src/core/api.js");
  let inflight = 0;
  let max = 0;
  const server = http.createServer((req, res) => {
    inflight += 1;
    max = Math.max(max, inflight);
    req.on("close", () => {
      inflight -= 1;
      res.destroy();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const candidate = { host: "127.0.0.1", port, timeout: 5000 };
  try {
    const first = new AbortController();
    const pending = probeApi([candidate], { signal: first.signal });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(inflight, 1);
    first.abort();
    await assert.rejects(pending, (err) => err.name === "AbortError");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(inflight, 0);

    const second = new AbortController();
    const again = probeApi([candidate], { signal: second.signal });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(max, 1);
    second.abort();
    await assert.rejects(again, (err) => err.name === "AbortError");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
