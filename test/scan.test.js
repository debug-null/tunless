import { test } from "node:test";
import assert from "node:assert/strict";
import { extractDomains } from "../src/core/scan.js";
import { mergeHosts } from "../src/core/plan.js";

const HISTORY = `
git clone https://code.17usoft.com/team/proj.git
curl -s https://matrix.17usoft.com/#/project/315/overview
open "https://a.b.17usoft.com/login"
pip install requests
node server.js
python3 script.py
ssh git@git.17usoft.com
cat ./README.md
vim config.yaml
ls image.png
`;

test("extractDomains finds hostnames in shell history", () => {
  const hosts = extractDomains(HISTORY);
  assert.ok(hosts.includes("code.17usoft.com"));
  assert.ok(hosts.includes("matrix.17usoft.com"));
  assert.ok(hosts.includes("a.b.17usoft.com"));
  assert.ok(hosts.includes("git.17usoft.com"));
});

test("extractDomains ignores file names and source files", () => {
  const hosts = extractDomains(HISTORY);
  for (const noise of ["requests", "server.js", "script.py", "readme.md", "config.yaml", "image.png"]) {
    assert.ok(!hosts.includes(noise), `${noise} should be ignored`);
  }
});

test("extractDomains de-duplicates and lowercases", () => {
  const hosts = extractDomains("HTTPS://Matrix.17usoft.com/x https://matrix.17usoft.com/y");
  assert.equal(hosts.filter((h) => h === "matrix.17usoft.com").length, 1);
});

test("scanned internal hosts collapse into suffix wildcards", () => {
  const hosts = extractDomains(HISTORY);
  const suffixes = mergeHosts(hosts);
  assert.ok(suffixes.includes("17usoft.com"));
});
