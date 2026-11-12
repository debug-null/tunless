import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  normalizeRule,
  addRule,
  removeRule,
  emptyRules,
  loadRules,
  saveRules,
  matchHostRules,
  matchIpRules,
  parseCidr,
  ipToInt,
  ipInCidr,
  ruleSuffixes,
} from "../src/core/rules.js";

test("域名规则默认按后缀匹配，+ 前缀会被去掉", () => {
  assert.deepEqual(normalizeRule("+.17usoft.com"), { kind: "domain", value: "17usoft.com" });
  assert.deepEqual(normalizeRule("*.corp.elong.com"), { kind: "domain", value: "corp.elong.com" });
});

test("不含点的输入当作关键词", () => {
  assert.deepEqual(normalizeRule("jira"), { kind: "keyword", value: "jira" });
});

test("IP 段能被识别，单 IP 视为 /32", () => {
  assert.deepEqual(normalizeRule("10.0.0.0/8"), { kind: "cidr", value: "10.0.0.0/8" });
  const cidr = parseCidr("10.1.2.3");
  assert.equal(cidr.bits, 32);
  assert.equal(ipInCidr("10.1.2.3", cidr), true);
  assert.equal(ipInCidr("10.1.2.4", cidr), false);
});

test("非法 IP 段给出中文错误而不是静默接受", () => {
  assert.throws(() => normalizeRule("10.0.0.0/99"), /不是合法的 IP 段/);
  assert.throws(() => normalizeRule("999.1.1.1"), /不是合法的 IP 段/);
});

test("域名后缀命中所有子域，关键词命中包含它的域名", () => {
  const rules = { domain: ["17usoft.com"], keyword: ["jira"], cidr: [] };
  assert.equal(matchHostRules("matrix.17usoft.com", rules), "domain");
  assert.equal(matchHostRules("17usoft.com", rules), "domain");
  assert.equal(matchHostRules("jira.internal.example.com", rules), "keyword");
  assert.equal(matchHostRules("github.com", rules), null);
});

test("IP 段规则匹配解析出来的私网地址", () => {
  const rules = { domain: [], keyword: [], cidr: ["10.0.0.0/8", "192.168.1.0/24"] };
  assert.equal(matchIpRules("10.2.3.4", rules), "10.0.0.0/8");
  assert.equal(matchIpRules("192.168.1.7", rules), "192.168.1.0/24");
  assert.equal(matchIpRules("8.8.8.8", rules), null);
});

test("添加与删除规则是幂等的", () => {
  let rules = emptyRules();
  const first = addRule(rules, "17usoft.com");
  assert.equal(first.added, true);
  rules = first.rules;
  const again = addRule(rules, "17usoft.com");
  assert.equal(again.added, false);
  assert.equal(again.rules.domain.length, 1);

  const removed = removeRule(again.rules, "17usoft.com");
  assert.equal(removed.removed, true);
  assert.equal(removed.rules.domain.length, 0);
  const twice = removeRule(removed.rules, "17usoft.com");
  assert.equal(twice.removed, false);
});

test("规则文件能往返读写，坏文件退化成空规则", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tunless-rules-"));
  const file = path.join(dir, "rules.json");
  const rules = { domain: ["17usoft.com"], keyword: ["jira"], cidr: ["10.0.0.0/8"] };
  saveRules(rules, file);
  assert.deepEqual(loadRules(file), rules);
  assert.deepEqual(ruleSuffixes(loadRules(file)), ["17usoft.com"]);

  fs.writeFileSync(file, "{ 这不是 json");
  assert.deepEqual(loadRules(file), emptyRules());
});

test("IP 转整数对非法输入返回 null", () => {
  assert.equal(ipToInt("10.0.0.1"), 167772161);
  assert.equal(ipToInt("10.0.0"), null);
  assert.equal(ipToInt("10.0.0.999"), null);
});
