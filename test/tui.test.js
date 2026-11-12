import { test } from "node:test";
import assert from "node:assert/strict";
import {
  displayWidth,
  truncate,
  padEnd,
  padStart,
  center,
  charWidth,
} from "../src/tui/width.js";
import { visibleLength } from "../src/tui/screen.js";
import { createKeyParser } from "../src/tui/keys.js";

test("中文按两个字符宽度计算", () => {
  assert.equal(displayWidth("内网域名"), 8);
  assert.equal(displayWidth("abc"), 3);
  assert.equal(displayWidth("内网 abc"), 8);
  assert.equal(charWidth("内".codePointAt(0)), 2);
  assert.equal(charWidth("a".codePointAt(0)), 1);
});

test("中文补空格按显示宽度对齐", () => {
  assert.equal(displayWidth(padEnd("内网", 10)), 10);
  assert.equal(displayWidth(padEnd("abc", 10)), 10);
  assert.equal(displayWidth(padStart("内网", 10)), 10);
  assert.equal(displayWidth(center("内网", 10)), 10);
});

test("超长中文按显示宽度截断并加省略号", () => {
  const cut = truncate("这是一个很长的中文字符串", 10);
  assert.ok(displayWidth(cut) <= 10);
  assert.ok(cut.endsWith("…"));
  assert.equal(truncate("短", 10), "短");
  assert.equal(truncate("abcdef", 3), "ab…");
});

test("可见长度忽略颜色转义码", () => {
  assert.equal(visibleLength("\x1b[32m内网\x1b[0m"), 4);
  assert.equal(visibleLength("普通"), 4);
});

test("按键解析识别字符、方向键与控制键", () => {
  const keys = [];
  const parser = createKeyParser((k) => keys.push(k));
  parser.handler("a");
  parser.handler("\x1b[A");
  parser.handler("\x1b[B");
  parser.handler("\r");
  parser.handler("\x03");
  assert.deepEqual(
    keys.map((k) => k.name),
    ["char", "up", "down", "enter", "ctrl-c"],
  );
  assert.equal(keys[0].char, "a");
});

test("按键解析能处理一次到达的多个按键", () => {
  const keys = [];
  const parser = createKeyParser((k) => keys.push(k.char));
  parser.handler("123");
  assert.deepEqual(keys, ["1", "2", "3"]);
});
