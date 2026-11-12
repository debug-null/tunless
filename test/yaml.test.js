import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseYaml,
  dumpYaml,
  extractTopLevelBlock,
  replaceTopLevelBlock,
} from "../src/core/yaml.js";
import { buildDnsSection } from "../src/core/plan.js";

test("yaml round-trips a tunless generated dns section", () => {
  const dns = buildDnsSection({
    internalDns: "10.249.150.130",
    internalSuffixes: ["17usoft.com", "cdb.17usoft.com"],
    existing: { enable: true },
  });
  const text = dumpYaml({ dns }, 0);
  const parsed = parseYaml(text);
  assert.deepEqual(parsed.dns, dns);
});

test("yaml quotes values that need it and parses them back", () => {
  const dns = buildDnsSection({
    internalDns: "10.249.150.130",
    internalSuffixes: ["cdb.17usoft.com"],
    existing: { "fake-ip-filter": ["+.cn-north.database-mysql.qa.cdb.17usoft.com"] },
  });
  const parsed = parseYaml(dumpYaml({ dns }, 0));
  assert.deepEqual(parsed.dns, dns);
});

test("extractTopLevelBlock returns only the requested block", () => {
  const text = [
    "port: 7897",
    "dns:",
    "  enable: true",
    "  nameserver:",
    "    - 1.1.1.1",
    "rules:",
    "  - MATCH,DIRECT",
  ].join("\n");
  const block = extractTopLevelBlock(text, "dns");
  assert.equal(block.split("\n")[0], "dns:");
  assert.ok(block.includes("  enable: true"));
  assert.ok(!block.includes("rules:"));
});

test("replaceTopLevelBlock swaps a block and keeps the rest", () => {
  const text = ["port: 7897", "dns:", "  enable: true", "rules:", "  - MATCH,DIRECT"].join("\n");
  const out = replaceTopLevelBlock(text, "dns", "dns:\n  enable: false");
  assert.ok(out.includes("dns:\n  enable: false"));
  assert.ok(out.includes("rules:"));
  assert.ok(out.includes("port: 7897"));
  assert.ok(!out.includes("enable: true"));
});

test("replaceTopLevelBlock appends a missing block", () => {
  const out = replaceTopLevelBlock("port: 7897\n", "dns", "dns:\n  enable: true");
  assert.ok(out.includes("port: 7897"));
  assert.ok(out.includes("dns:"));
});

test("yaml strips quotes from keys and list items", () => {
  const text = [
    "dns:",
    "  nameserver-policy:",
    '    "17usoft.com":',
    "      - 10.249.150.130",
    "  fake-ip-filter:",
    '    - "+.17usoft.com"',
  ].join("\n");
  const parsed = parseYaml(text);
  assert.deepEqual(parsed.dns["nameserver-policy"], { "17usoft.com": ["10.249.150.130"] });
  assert.deepEqual(parsed.dns["fake-ip-filter"], ["+.17usoft.com"]);
});
