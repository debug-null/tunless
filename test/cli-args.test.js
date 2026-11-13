import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../src/cli.js";

test("布尔开关不吃掉后面的位置参数", () => {
  const a = parseArgs(["launch", "--write-settings", "Antigravity"]);
  assert.deepEqual(a._, ["launch", "Antigravity"]);
  assert.equal(a.flags["write-settings"], true);
});

test("开关写在位置参数后面也一样", () => {
  const b = parseArgs(["launch", "Antigravity", "--write-settings"]);
  assert.deepEqual(b._, ["launch", "Antigravity"]);
  assert.equal(b.flags["write-settings"], true);
});

test("带值的选项仍然正常取下一个参数", () => {
  const c = parseArgs(["fix", "--internal-dns", "10.0.0.1", "--yes"]);
  assert.equal(c.flags["internal-dns"], "10.0.0.1");
  assert.equal(c.flags.yes, true);
  assert.deepEqual(c._, ["fix"]);
});

test("rules 的关键词开关不会被当成值", () => {
  const d = parseArgs(["rules", "add", "jira", "--keyword"]);
  assert.deepEqual(d._, ["rules", "add", "jira"]);
  assert.equal(d.flags.keyword, true);
});

test("--key=value 形式不受影响", () => {
  const e = parseArgs(["fix", "--internal-dns=10.0.0.1"]);
  assert.equal(e.flags["internal-dns"], "10.0.0.1");
});
