import { test } from "node:test";
import assert from "node:assert/strict";
import { restrictedEgress, _resetEgressCache } from "../src/core/egress.js";
import { rowsFor } from "../src/core/status-rows.js";

test("受限地区名单：命中与不命中", () => {
  for (const c of ["CN", "HK", "MO", "RU", "IR", "KP"]) {
    assert.equal(restrictedEgress(c), true, c);
  }
  for (const c of ["JP", "US", "DE", "SG", "TW", "GB", null, undefined, ""]) {
    assert.equal(restrictedEgress(c), false, String(c));
  }
});

test("上游行：出口受限 → warn，并提示切节点", () => {
  const state = {
    upstream: { chosen: { host: "127.0.0.1", port: 7897 }, detail: "" },
    egress: { country: "HK", restricted: true },
  };
  const row = rowsFor(state).find((r) => r.id === "upstream");
  assert.equal(row.status, "warn");
  assert.match(row.detail, /出口HK/);
  assert.match(row.detail, /不可用/);
  assert.equal(row.action, "切上游节点");
});

test("上游行：出口正常 → ok，detail 附出口地区", () => {
  const state = {
    upstream: { chosen: { host: "127.0.0.1", port: 7897 }, detail: "" },
    egress: { country: "JP", restricted: false },
  };
  const row = rowsFor(state).find((r) => r.id === "upstream");
  assert.equal(row.status, "ok");
  assert.match(row.detail, /出口JP/);
});

test("上游行：egress 未知（null）不干扰原有判定", () => {
  const state = {
    upstream: { chosen: { host: "127.0.0.1", port: 7897 }, detail: "" },
    egress: null,
  };
  const row = rowsFor(state).find((r) => r.id === "upstream");
  assert.equal(row.status, "ok");
  assert.doesNotMatch(row.detail, /出口/);
});

test("上游行：drift 优先于 egress 提示", () => {
  const state = {
    upstream: {
      chosen: { host: "127.0.0.1", port: 7897 },
      detail: "",
      drift: "你固定的 7897 已过期",
    },
    egress: { country: "HK", restricted: true },
  };
  const row = rowsFor(state).find((r) => r.id === "upstream");
  assert.match(row.detail, /已过期/);
});
