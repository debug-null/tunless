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

test("上游行：出口样本只警告地区，不当成目标或模型不可用", () => {
  const state = {
    upstream: { chosen: { host: "127.0.0.1", port: 7897 }, detail: "" },
    egress: { country: "HK", restricted: true },
  };
  const row = rowsFor(state).find((r) => r.id === "upstream");
  assert.equal(row.status, "warn");
  assert.match(row.detail, /出口样本HK/);
  assert.match(row.detail, /不能/);
  assert.doesNotMatch(row.detail, /目录完整/);
  assert.doesNotMatch(row.detail, /在该区不可用/);
});

test("上游行：SG/US/JP 样本不能写成模型目录完整", () => {
  for (const country of ["JP", "SG", "US"]) {
    const state = {
      upstream: { chosen: { host: "127.0.0.1", port: 7897 }, detail: "" },
      egress: { country, restricted: false },
    };
    const row = rowsFor(state).find((r) => r.id === "upstream");
    assert.equal(row.status, "ok");
    assert.match(row.detail, new RegExp(`出口样本${country}`));
    assert.match(row.detail, /不能/);
    assert.doesNotMatch(row.detail, /目录完整/);
  }
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
