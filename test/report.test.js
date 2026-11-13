import { test } from "node:test";
import assert from "node:assert/strict";
import { createReporter } from "../src/cli/report.js";

const capture = () => {
  const lines = [];
  return { lines, out: (t) => lines.push(t) };
};

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("row：状态符号 + 标签 + 详情 + 动作", () => {
  const { lines, out } = capture();
  const rep = createReporter({ color: false, unicode: true, out });
  rep.row("ok", "服务", "运行中 pid 1");
  rep.row("bad", "内核", "不可达", "按 f 修复");
  assert.equal(lines[0], "  ✔ 服务   运行中 pid 1");
  assert.equal(lines[1], "  ✖ 内核   不可达 · 按 f 修复");
});

test("unknown 显式显示而不是隐藏", () => {
  const { lines, out } = capture();
  createReporter({ color: false, unicode: true, out }).row("unknown", "TUN", "读不到");
  assert.match(lines[0], /\? TUN/);
});

test("ASCII 降级：TUNLESS_ASCII=1 风格符号", () => {
  const { lines, out } = capture();
  const rep = createReporter({ color: false, unicode: false, out });
  rep.row("ok", "服务", "好");
  rep.row("warn", "上游", "旧");
  rep.row("bad", "内核", "挂");
  assert.match(lines[0], /\+ 服务/);
  assert.match(lines[1], /! 上游/);
  assert.match(lines[2], /x 内核/);
});

test("color:false 时不带 ANSI；color:true 时上色", () => {
  const a = capture();
  createReporter({ color: false, out: a.out }).section("环境");
  assert.equal(strip(a.lines.at(-1)), a.lines.at(-1));
  const b = capture();
  createReporter({ color: true, unicode: true, out: b.out }).row("ok", "服务", "好");
  assert.notEqual(strip(b.lines[0]), b.lines[0]);
});

test("verdict/section/suggest 形状", () => {
  const { lines, out } = capture();
  const rep = createReporter({ color: false, unicode: true, out });
  rep.verdict("ok", "一切正常");
  rep.section("环境");
  rep.suggest("tunless service start");
  assert.equal(lines[0], " ● 一切正常");
  assert.equal(lines[2], "── 环境 ──");
  assert.equal(lines[3], "    → tunless service start");
});
