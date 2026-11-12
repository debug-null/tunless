// 终端渲染：只重绘变化的行，避免整屏刷新导致的闪烁，
// 并在退出时把光标和终端状态还原。

import { displayWidth, truncate } from "./width.js";

const ESC = "\x1b[";

export class Screen {
  constructor({ stream = process.stdout } = {}) {
    this.stream = stream;
    this.previous = [];
    this.started = false;
    this.altScreen = false;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.stream.write(`${ESC}?1049h`); // 切换到备用屏幕
    this.altScreen = true;
    this.stream.write(`${ESC}?25l`); // 隐藏光标
    this.stream.write(`${ESC}2J${ESC}H`);
  }

  stop() {
    if (!this.started) return;
    this.stream.write(`${ESC}0m${ESC}?25h`);
    if (this.altScreen) {
      this.stream.write(`${ESC}?1049l`); // 还原主屏幕
      this.altScreen = false;
    }
    this.started = false;
  }

  get width() {
    return this.stream.columns || 80;
  }

  get height() {
    return this.stream.rows || 24;
  }

  // lines: 纯文本行数组（可含 ANSI 颜色码）
  render(lines) {
    if (!this.started) this.start();
    const width = this.width;
    const height = this.height;
    const frame = lines.slice(0, height);

    // 内容完全没变就不重绘，避免每秒闪一次。
    const changed =
      frame.length !== this.previous.length ||
      frame.some((line, i) => line !== this.previous[i]);
    if (!changed) return;

    let out = "";
    out += `${ESC}H`;
    for (let i = 0; i < frame.length; i += 1) {
      const text = frame[i];
      const visible = visibleLength(text);
      // 每行都完整重写：只发定位码会让终端保留上一帧的内容，
      // 在内容变短或含颜色码时就会出现错位与残影。
      out += `${ESC}${i + 1};1H${ESC}K${text}`;
      if (visible > width) {
        out += `${ESC}0K`;
      }
      out += "\x1b[0m";
    }
    // 多余的行清空
    for (let i = frame.length; i < this.previous.length; i += 1) {
      out += `${ESC}${i + 1};1H${ESC}K`;
    }
    out += `${ESC}${Math.min(frame.length + 1, height)};1H`;
    this.stream.write(out);
    this.previous = frame;
  }

  clear() {
    this.stream.write(`${ESC}2J${ESC}H`);
    this.previous = [];
  }
}

// 去掉 ANSI 转义后的可见长度，用于判断是否超出终端宽度。
export function visibleLength(text) {
  return displayWidth(String(text).replace(/\x1b\[[0-9;]*m/g, ""));
}

export function fitLine(text, width) {
  if (visibleLength(text) <= width) return text;
  return truncate(String(text).replace(/\x1b\[[0-9;]*m/g, ""), width);
}
