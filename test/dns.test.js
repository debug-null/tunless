import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildQuery,
  parseResponse,
  classifyIp,
  isPrivateIp,
  isFakeIp,
} from "../src/core/dns.js";

test("buildQuery encodes a domain name into a DNS query packet", () => {
  const q = buildQuery("example.com", 1);
  assert.equal(q.readUInt16BE(0), 0x1234);
  assert.equal(q.readUInt16BE(2), 0x0100);
  assert.equal(q.readUInt16BE(4), 1);
  assert.equal(q[4], 0);
  assert.equal(q[5], 1); // qdcount = 1
  // header(12) + len("example")+example + len("com")+com + 0 + qtype(4)
  assert.equal(q.length, 12 + 1 + 7 + 1 + 3 + 1 + 4);
  assert.equal(q[12], 7);
  assert.equal(q[13], 0x65);
});

function makeResponse(answers, { rcode = 0, qname = "example.com" } = {}) {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x1234, 0);
  header.writeUInt16BE(0x8180 | rcode, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(answers.length, 6);

  const q = buildQuery(qname, 1);
  const question = q.subarray(12);
  const body = [];
  for (const a of answers) {
    const rr = Buffer.alloc(16);
    rr.writeUInt16BE(0xc00c, 0); // name: pointer to question name at offset 12
    rr.writeUInt16BE(1, 2); // type A
    rr.writeUInt16BE(1, 4); // class IN
    rr.writeUInt32BE(300, 6); // ttl
    rr.writeUInt16BE(4, 10); // rdlength
    rr[12] = a[0];
    rr[13] = a[1];
    rr[14] = a[2];
    rr[15] = a[3];
    body.push(rr);
  }
  return Buffer.concat([header, question, ...body]);
}

test("parseResponse extracts A records", () => {
  const msg = makeResponse([[172, 27, 242, 17]]);
  const parsed = parseResponse(msg);
  assert.equal(parsed.rcode, 0);
  assert.equal(parsed.answers.length, 1);
  assert.equal(parsed.answers[0].data, "172.27.242.17");
  assert.equal(parsed.answers[0].type, 1);
});

test("parseResponse returns empty answers for NXDOMAIN", () => {
  const msg = makeResponse([], { rcode: 3 });
  const parsed = parseResponse(msg);
  assert.equal(parsed.rcode, 3);
  assert.deepEqual(parsed.answers, []);
});

test("parseResponse handles multiple A records", () => {
  const msg = makeResponse([
    [10, 176, 201, 75],
    [172, 27, 249, 23],
  ]);
  const parsed = parseResponse(msg);
  assert.deepEqual(parsed.answers.map((a) => a.data), ["10.176.201.75", "172.27.249.23"]);
});

test("classifyIp distinguishes private, fake and public addresses", () => {
  assert.equal(classifyIp("10.176.201.75"), "private");
  assert.equal(classifyIp("172.27.242.17"), "private");
  assert.equal(classifyIp("172.16.0.1"), "private");
  assert.equal(classifyIp("172.32.0.1"), "public");
  assert.equal(classifyIp("192.168.1.1"), "private");
  assert.equal(classifyIp("127.0.0.1"), "private");
  assert.equal(classifyIp("198.18.0.60"), "fake");
  assert.equal(classifyIp("8.8.8.8"), "public");
  assert.equal(classifyIp("101.42.128.27"), "public");
});

test("isPrivateIp covers the RFC1918 ranges", () => {
  assert.ok(isPrivateIp("10.1.2.3"));
  assert.ok(isPrivateIp("172.20.1.1"));
  assert.ok(!isPrivateIp("172.15.1.1"));
  assert.ok(!isPrivateIp("11.1.1.1"));
});

test("isFakeIp matches the 198.18.0.0/16 fake-ip range", () => {
  assert.ok(isFakeIp("198.18.0.60"));
  assert.ok(!isFakeIp("198.19.0.1"));
});
