import { test } from "node:test";
import assert from "node:assert/strict";
import { overviewLines, rowsFor, verdictFor } from "../src/core/status-rows.js";

const base = {
  loading: false,
  sidecar: { running: true, installed: true, pid: 1234, httpPort: 8899, socksPort: 8898, activeSuffixes: ["17u.cn"], pendingSuffixes: [] },
  upstream: { pinned: null, chosen: { host: "127.0.0.1", port: 6478 }, detail: "wmsxwd", drift: null },
  apps: [
    { id: "antigravity", name: "Antigravity", installed: true, running: true, proxied: "ok" },
    { id: "cursor", name: "Cursor", installed: true, running: true, proxied: "ok" },
  ],
  dnsAlive: true,
  internalDns: "10.249.150.130",
  suffixes: ["17u.cn"],
  internalDomains: [{ name: "a.17u.cn", ips: ["10.0.0.1"] }],
  fakeCount: 0,
};

const byId = (rows, id) => rows.find((r) => r.id === id);

test("全健康：四行全 ok，判决一切正常", () => {
  const rows = rowsFor(base);
  assert.deepEqual(rows.map((r) => r.status), ["ok", "ok", "ok", "ok"]);
  assert.equal(verdictFor(base).tone, "ok");
});

test("服务停了：bad + 行内动作按 s", () => {
  const st = { ...base, sidecar: { ...base.sidecar, running: false } };
  const row = byId(rowsFor(st), "service");
  assert.equal(row.status, "bad");
  assert.match(row.action, /按 s/);
  assert.equal(verdictFor(st).tone, "bad");
});

test("服务从未安装：warn + 引导动作", () => {
  const st = { ...base, sidecar: { ...base.sidecar, running: false, installed: false } };
  const row = byId(rowsFor(st), "service");
  assert.equal(row.status, "warn");
  assert.match(row.action, /g/);
});

test("上游缺失：bad + 按 u", () => {
  const st = { ...base, upstream: { pinned: null, chosen: null, detail: "", drift: null } };
  assert.equal(byId(rowsFor(st), "upstream").status, "bad");
});

test("上游漂移：warn 而不是 ok", () => {
  const st = { ...base, upstream: { ...base.upstream, drift: "pinned 已过期" } };
  assert.equal(byId(rowsFor(st), "upstream").status, "warn");
});

test("工具 stale：warn；运行但未走代理：unknown 不记故障", () => {
  const stale = { ...base, apps: [{ ...base.apps[0], proxied: "stale" }, base.apps[1]] };
  assert.equal(byId(rowsFor(stale), "tools").status, "warn");
  const unknown = { ...base, apps: [{ ...base.apps[0], proxied: "unknown" }, base.apps[1]] };
  assert.equal(byId(rowsFor(unknown), "tools").status, "ok");
});

test("内网 DNS 死：warn；假 IP：bad + 按 f", () => {
  const dnsDead = { ...base, dnsAlive: false };
  assert.equal(byId(rowsFor(dnsDead), "internal").status, "warn");
  const fake = { ...base, fakeCount: 2 };
  const row = byId(rowsFor(fake), "internal");
  assert.equal(row.status, "bad");
  assert.match(row.action, /按 f/);
});

test("待生效后缀：warn 并给数字", () => {
  const st = { ...base, sidecar: { ...base.sidecar, pendingSuffixes: ["a.cn", "b.cn"] } };
  const row = byId(rowsFor(st), "internal");
  assert.equal(row.status, "warn");
  assert.match(row.detail, /2/);
});

test("loading：全 unknown，判决不报警", () => {
  const rows = rowsFor({ loading: true });
  assert.ok(rows.every((r) => r.status === "unknown"));
  assert.equal(verdictFor({ loading: true }).tone, "info");
});

test("守护进程跑旧版：warn + 指明版本与 restart 动作", () => {
  const st = {
    ...base,
    pkgVersion: "0.11.1",
    sidecar: { ...base.sidecar, staleCode: true, runtimeVersion: "0.10.1" },
  };
  const row = byId(rowsFor(st), "service");
  assert.equal(row.status, "warn");
  assert.match(row.detail, /0\.10\.1/);
  assert.match(row.detail, /0\.11\.1/);
  assert.match(row.action, /service restart/);
  assert.equal(verdictFor(st).tone, "warn");
});

test("守护进程版本字段缺失（旧版无记录）：也报 warn", () => {
  const st = {
    ...base,
    pkgVersion: "0.11.1",
    sidecar: { ...base.sidecar, staleCode: true, runtimeVersion: null },
  };
  const row = byId(rowsFor(st), "service");
  assert.equal(row.status, "warn");
  assert.match(row.detail, /旧版/);
});

test("工具探测失败：标「未测出」而不是谎报「未走代理」", () => {
  const st = { ...base, apps: [{ ...base.apps[0], proxied: "probe-error" }, base.apps[1]] };
  const row = byId(rowsFor(st), "tools");
  assert.match(row.detail, /Antigravity \?未测出/);
  assert.doesNotMatch(row.detail, /Antigravity 未走代理/);
  // 探测失败不拖整行：另一个应用 ok 则行仍 ok
  assert.equal(row.status, "ok");
});

test("总览把隧道和模型分开，认证端口和 403 都不写成可用", () => {
  const lines = overviewLines(
    {
      ...base,
      sidecar: { ...base.sidecar, httpOpen: true, socksOpen: false },
      upstream: {
        chosen: null,
        candidates: [{ host: "127.0.0.1", port: 6152, protocols: [], authRequired: ["http"], usable: false }],
      },
      egress: { country: "SG", restricted: false },
    },
    {
      app: { name: "Cursor", running: true, proxied: "unknown" },
      reach: { ok: true, serviceVerified: false, results: [{ httpStatus: 403 }, { httpStatus: 429 }] },
    },
  );
  const text = lines.map((l) => `${l.label} ${l.detail}`).join("\n");
  assert.match(text, /HTTP 开 :8899/);
  assert.match(text, /需要认证/);
  assert.match(text, /HTTP 403\/429/);
  assert.match(text, /模型 未验证/);
  assert.doesNotMatch(text, /目录完整|模型可用/);
});
