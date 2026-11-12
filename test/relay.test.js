import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideRoute,
  hostMatchesSuffix,
  splitHostPort,
  normalizeHost,
} from "../src/core/relay.js";

const suffixes = ["17usoft.com", "cdb.17usoft.com", "17u.cn"];

test("hostMatchesSuffix matches a domain and its subdomains", () => {
  assert.ok(hostMatchesSuffix("matrix.17usoft.com", "17usoft.com"));
  assert.ok(hostMatchesSuffix("17usoft.com", "17usoft.com"));
  assert.ok(hostMatchesSuffix("a.b.17usoft.com", "17usoft.com"));
  assert.ok(hostMatchesSuffix("cn-north.database-mysql.qa.cdb.17usoft.com", "cdb.17usoft.com"));
});

test("hostMatchesSuffix does not match unrelated or partial domains", () => {
  assert.ok(!hostMatchesSuffix("not17usoft.com", "17usoft.com"));
  assert.ok(!hostMatchesSuffix("17usoft.com.evil.net", "17usoft.com"));
  assert.ok(!hostMatchesSuffix("github.com", "17usoft.com"));
});

test("hostMatchesSuffix understands the +. wildcard form", () => {
  assert.ok(hostMatchesSuffix("matrix.17usoft.com", "+.17usoft.com"));
});

test("decideRoute sends internal domains direct and the rest upstream", () => {
  assert.equal(decideRoute("matrix.17usoft.com", { internalSuffixes: suffixes }), "internal");
  assert.equal(decideRoute("wiki.17u.cn", { internalSuffixes: suffixes }), "internal");
  assert.equal(decideRoute("github.com", { internalSuffixes: suffixes }), "upstream");
});

test("splitHostPort parses host:port, bracketed IPv6 and defaults", () => {
  assert.deepEqual(splitHostPort("example.com:443", 80), { host: "example.com", port: 443 });
  assert.deepEqual(splitHostPort("example.com", 80), { host: "example.com", port: 80 });
  assert.deepEqual(splitHostPort("[::1]:8080", 80), { host: "::1", port: 8080 });
});

test("normalizeHost lowercases and strips wildcard/root dots", () => {
  assert.equal(normalizeHost("Matrix.17usoft.com."), "matrix.17usoft.com");
  assert.equal(normalizeHost("*.example.com"), "example.com");
});
