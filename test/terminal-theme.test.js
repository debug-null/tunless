import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseBackgroundColor,
  parseTerminalBackgroundReply,
  colorSchemeFromRgb,
} from "../src/tui/terminal-theme.js";

test("解析 rgb: 与 # 两种背景色写法", () => {
  assert.deepEqual(parseBackgroundColor("rgb:0000/0000/0000"), { r: 0, g: 0, b: 0 });
  assert.deepEqual(parseBackgroundColor("#ffffff"), { r: 255, g: 255, b: 255 });
  assert.deepEqual(parseBackgroundColor("rgba:ff/80/00"), { r: 255, g: 128, b: 0 });
  assert.equal(parseBackgroundColor("不是颜色"), null);
});

test("从 OSC 11 应答里取出背景色", () => {
  assert.deepEqual(parseTerminalBackgroundReply("\x1b]11;rgb:1c1c/1c1c/1c1c\x07"), {
    r: 28,
    g: 28,
    b: 28,
  });
  assert.equal(parseTerminalBackgroundReply("随便一段噪声"), null);
});

test("按感知亮度区分亮底与暗底", () => {
  assert.equal(colorSchemeFromRgb(0, 0, 0), "dark");
  assert.equal(colorSchemeFromRgb(255, 255, 255), "light");
  assert.equal(colorSchemeFromRgb(20, 20, 20), "dark");
  assert.equal(colorSchemeFromRgb(240, 240, 240), "light");
});
