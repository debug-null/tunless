import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");

test("安装包里的验收命令不依赖 test 目录，失败时留下真实错误", async () => {
  const script = await readFile(path.join(root, "scripts/round1-accept.mjs"), "utf8");
  assert.doesNotMatch(script, /test\/round1/);
  assert.match(script, /失败/);

  const dir = await mkdtemp(path.join(os.tmpdir(), "tunless-pack-"));
  try {
    const { stdout } = await exec("npm", ["pack", "--pack-destination", dir], { cwd: root });
    const tarball = path.join(dir, stdout.trim().split("\n").at(-1));
    await exec("tar", ["-xzf", tarball, "-C", dir]);
    const packed = path.join(dir, "package");
    const packedScript = await readFile(path.join(packed, "scripts/round1-accept.mjs"), "utf8");
    assert.doesNotMatch(packedScript, /test\/round1/);
    const run = await exec(process.execPath, ["scripts/round1-accept.mjs"], {
      cwd: packed,
      env: { ...process.env, HOME: dir },
    });
    assert.match(run.stdout, /验收通过/);
    assert.match(run.stdout, /504/);
    assert.match(run.stdout, /502/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
