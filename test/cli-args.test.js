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

// 回归：以前只认 --yes，单横线的 -y 会掉进位置参数，
// `fix -y` 照样弹确认，`launch -y Antigravity` 更糟——应用名被吃成 -y。
test("单横线短选项映射到长选项", () => {
  const a = parseArgs(["fix", "-y"]);
  assert.equal(a.flags.yes, true);
  assert.deepEqual(a._, ["fix"]);

  const b = parseArgs(["launch", "-y", "Antigravity"]);
  assert.equal(b.flags.yes, true);
  assert.deepEqual(b._, ["launch", "Antigravity"]);
});

test("-h / -v 映射 help / version", () => {
  assert.equal(parseArgs(["-h"]).flags.help, true);
  assert.equal(parseArgs(["-v"]).flags.version, true);
});

test("不认识的短选项当位置参数而不是静默吃掉", () => {
  const a = parseArgs(["proxy", "-x"]);
  assert.deepEqual(a._, ["proxy", "-x"]);
});

test("--no-session-env 是纯开关，不吃下一个参数", () => {
  const a = parseArgs(["proxy", "--no-session-env", "--port", "8899"]);
  assert.equal(a.flags["no-session-env"], true);
  assert.equal(a.flags.port, "8899");
});

test("--config 是带值选项", () => {
  const a = parseArgs(["fix", "--config", "/tmp/mihomo.yaml"]);
  assert.equal(a.flags.config, "/tmp/mihomo.yaml");
  assert.deepEqual(a._, ["fix"]);
});
