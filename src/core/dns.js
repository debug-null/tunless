import dgram from "node:dgram";

export const FAKE_IP_PREFIX = "198.18.";

const PRIVATE_PATTERNS = [
  /^10\./,
  /^127\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
];

export function isPrivateIp(ip) {
  return PRIVATE_PATTERNS.some((re) => re.test(ip));
}

export function isFakeIp(ip) {
  return ip.startsWith(FAKE_IP_PREFIX);
}

export function classifyIp(ip) {
  if (isFakeIp(ip)) return "fake";
  if (isPrivateIp(ip)) return "private";
  return "public";
}

export function buildQuery(name, type = 1) {
  const labels = name.split(".").filter(Boolean);
  const header = Buffer.alloc(12);
  header.writeUInt16BE(0x1234, 0);
  header.writeUInt16BE(0x0100, 2);
  header.writeUInt16BE(1, 4);

  const parts = [];
  for (const label of labels) {
    const bytes = Buffer.from(label, "ascii");
    if (bytes.length > 63) throw new Error(`label too long: ${label}`);
    parts.push(Buffer.from([bytes.length]), bytes);
  }
  parts.push(Buffer.from([0]));

  const qtype = Buffer.alloc(4);
  qtype.writeUInt16BE(type, 0);
  qtype.writeUInt16BE(1, 2);

  return Buffer.concat([header, ...parts, qtype]);
}

function readName(msg, offset) {
  const labels = [];
  let off = offset;
  let jumped = false;
  let endOffset = offset;
  let guard = 0;

  while (off < msg.length) {
    if (++guard > 128) throw new Error("dns name loop");
    const len = msg[off];
    if (len === 0) {
      off += 1;
      if (!jumped) endOffset = off;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      const pointer = msg.readUInt16BE(off) & 0x3fff;
      if (!jumped) endOffset = off + 2;
      off = pointer;
      jumped = true;
      continue;
    }
    labels.push(msg.subarray(off + 1, off + 1 + len).toString("ascii"));
    off += len + 1;
    if (!jumped) endOffset = off;
  }
  return { name: labels.join("."), offset: endOffset };
}

export function parseResponse(msg) {
  if (msg.length < 12) throw new Error("dns response too short");
  const rcode = msg.readUInt16BE(2) & 0x0f;
  const qdcount = msg.readUInt16BE(4);
  const ancount = msg.readUInt16BE(6);

  let off = 12;
  for (let i = 0; i < qdcount; i++) {
    const q = readName(msg, off);
    off = q.offset + 4;
  }

  const answers = [];
  for (let i = 0; i < ancount; i++) {
    const owner = readName(msg, off);
    off = owner.offset;
    if (off + 10 > msg.length) break;
    const type = msg.readUInt16BE(off);
    const ttl = msg.readUInt32BE(off + 4);
    const rdlength = msg.readUInt16BE(off + 8);
    off += 10;
    const rdata = msg.subarray(off, off + rdlength);

    if (type === 1 && rdlength === 4) {
      answers.push({ name: owner.name, type: 1, ttl, data: [...rdata].join(".") });
    } else if (type === 5) {
      answers.push({ name: owner.name, type: 5, ttl, data: readName(msg, off).name });
    } else if (type === 16) {
      answers.push({ name: owner.name, type: 16, ttl, data: rdata.toString("ascii") });
    }
    off += rdlength;
  }

  return { rcode, answers };
}

export function queryA(name, server, { timeout = 3000, port = 53 } = {}) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    const payload = buildQuery(name, 1);
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        socket.close();
      } catch {}
      resolve(value);
    };

    const timer = setTimeout(() => finish({ ok: false, error: "timeout", ips: [] }), timeout);
    timer.unref?.();

    socket.on("message", (msg) => {
      clearTimeout(timer);
      try {
        const parsed = parseResponse(msg);
        const ips = parsed.answers.filter((a) => a.type === 1).map((a) => a.data);
        finish({
          ok: true,
          ips,
          rcode: parsed.rcode,
          answers: parsed.answers,
        });
      } catch (err) {
        finish({ ok: false, error: err.message, ips: [] });
      }
    });

    socket.on("error", (err) => {
      clearTimeout(timer);
      finish({ ok: false, error: err.code || err.message, ips: [] });
    });

    socket.send(payload, 0, payload.length, port, server, (err) => {
      if (err) {
        clearTimeout(timer);
        finish({ ok: false, error: err.code || err.message, ips: [] });
      }
    });
  });
}

export async function classifyDomain(name, server, options = {}) {
  const res = await queryA(name, server, options);
  if (!res.ok) return { name, server, ok: false, error: res.error, ips: [], kind: "error" };

  const kinds = res.ips.map(classifyIp);
  let kind = "public";
  if (res.ips.length === 0) kind = "nxdomain";
  else if (kinds.includes("private")) kind = "internal";
  else if (kinds.every((k) => k === "fake")) kind = "fake";

  return { name, server, ok: true, ips: res.ips, kind };
}
