import { test } from "node:test";
import assert from "node:assert/strict";
import {
  registrableSuffix,
  mergeHosts,
  partitionByKind,
  buildDnsSection,
} from "../src/core/plan.js";

test("registrableSuffix uses the last two labels for normal domains", () => {
  assert.equal(registrableSuffix("matrix.17usoft.com"), "17usoft.com");
  assert.equal(registrableSuffix("a.b.17usoft.com"), "17usoft.com");
  assert.equal(registrableSuffix("wiki.17u.cn"), "17u.cn");
});

test("registrableSuffix keeps three labels for multi-label public suffixes", () => {
  assert.equal(registrableSuffix("a.b.example.com.cn"), "example.com.cn");
});

test("mergeHosts collapses sibling subdomains into one suffix", () => {
  assert.deepEqual(
    mergeHosts(["a.b.17usoft.com", "c.17usoft.com"]),
    ["17usoft.com"],
  );
});

test("mergeHosts keeps a sub-delegation separate when the parent is observed", () => {
  assert.deepEqual(
    mergeHosts(["cdb.17usoft.com", "17usoft.com"]),
    ["17usoft.com", "cdb.17usoft.com"],
  );
});

test("mergeHosts collapses hosts of unrelated registrable domains separately", () => {
  assert.deepEqual(
    mergeHosts(["matrix.17usoft.com", "git.17usoft.com", "wiki.17u.cn"]),
    ["17u.cn", "17usoft.com"],
  );
});

test("partitionByKind splits internal, fake, public and unresolved hosts", () => {
  const { internal, fake, publicHosts, unresolved } = partitionByKind([
    { ok: true, name: "matrix.17usoft.com", kind: "internal", ips: ["10.1.1.1"] },
    { ok: true, name: "a.example.com", kind: "fake", ips: ["198.18.0.5"] },
    { ok: true, name: "b.example.com", kind: "public", ips: ["1.2.3.4"] },
    { ok: false, name: "c.example.com", kind: "error", ips: [], error: "timeout" },
  ]);
  assert.equal(internal.length, 1);
  assert.equal(fake.length, 1);
  assert.equal(publicHosts.length, 1);
  assert.equal(unresolved.length, 1);
});

test("buildDnsSection adds nameserver-policy and fake-ip-filter entries", () => {
  const dns = buildDnsSection({
    internalDns: "10.249.150.130",
    internalSuffixes: ["17usoft.com", "cdb.17usoft.com"],
    existing: {},
  });
  assert.deepEqual(dns["nameserver-policy"], {
    "17usoft.com": ["10.249.150.130"],
    "cdb.17usoft.com": ["10.249.150.130"],
  });
  assert.ok(dns["fake-ip-filter"].includes("+.17usoft.com"));
  assert.ok(dns["fake-ip-filter"].includes("+.cdb.17usoft.com"));
  assert.ok(dns.nameserver.includes("10.249.150.130"));
});

test("buildDnsSection keeps public domains out of the internal policy", () => {
  const dns = buildDnsSection({
    internalDns: "10.249.150.130",
    internalSuffixes: ["17usoft.com"],
    existing: {},
  });
  assert.ok(!("example.com" in dns["nameserver-policy"]));
  assert.ok(!dns["fake-ip-filter"].some((e) => e.includes("example.com")));
});

test("buildDnsSection preserves existing dns settings", () => {
  const dns = buildDnsSection({
    internalDns: "10.249.150.130",
    internalSuffixes: ["17usoft.com"],
    existing: {
      enable: true,
      "fake-ip-filter": ["+.lan", "*.local"],
      nameserver: ["1.1.1.1"],
    },
  });
  assert.equal(dns.enable, true);
  assert.ok(dns["fake-ip-filter"].includes("+.lan"));
  assert.ok(dns["fake-ip-filter"].includes("*.local"));
  assert.ok(dns.nameserver.includes("1.1.1.1"));
});
