// 中文终端里字符宽度不等于字符个数：汉字、假名、全角标点占两列，
// 组合字符与零宽字符不占列。表格对齐必须按显示宽度计算，
// 否则中文一多整个界面就会错位。
//
// 截断按「字素簇」（grapheme cluster）而不是码点进行，
// 避免把 emoji 组合序列、附加符号切成半个乱码。

const WIDE_RANGES = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

const ZERO_WIDTH_RANGES = [
  [0x0300, 0x036f],
  [0x200b, 0x200f],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
];

const ZWJ = 0x200d;
const EMOJI_START = 0x1f300;
const EMOJI_END = 0x1faff;

function inRanges(code, ranges) {
  for (const [start, end] of ranges) {
    if (code >= start && code <= end) return true;
  }
  return false;
}

export function charWidth(code) {
  if (code === 0x0a || code === 0x0d) return 0;
  if (inRanges(code, ZERO_WIDTH_RANGES)) return 0;
  if (inRanges(code, WIDE_RANGES)) return 2;
  return 1;
}

const segmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/** 按字素簇切分字符串 */
export function splitGraphemes(value) {
  const text = String(value ?? "");
  if (!segmenter) return Array.from(text);
  return Array.from(segmenter.segment(text), ({ segment }) => segment);
}

/**
 * 一个字素簇占多少列。
 * emoji 组合序列（ZWJ 连接的家族、肤色修饰等）整体按两列算。
 */
export function graphemeWidth(grapheme) {
  let width = 0;
  let hasEmoji = false;
  for (const char of grapheme) {
    const code = char.codePointAt(0) ?? 0;
    if (code === ZWJ) continue;
    if (code >= EMOJI_START && code <= EMOJI_END) hasEmoji = true;
    width += charWidth(code);
  }
  if (hasEmoji) return 2;
  return width;
}

export function displayWidth(text) {
  let width = 0;
  for (const grapheme of splitGraphemes(text)) {
    width += graphemeWidth(grapheme);
  }
  return width;
}

// 按显示宽度截断，超出部分用 … 收尾。
export function truncate(text, maxWidth) {
  const str = String(text ?? "");
  if (maxWidth <= 0) return "";
  if (displayWidth(str) <= maxWidth) return str;
  let width = 0;
  let out = "";
  for (const grapheme of splitGraphemes(str)) {
    const w = graphemeWidth(grapheme);
    if (width + w > maxWidth - 1) break;
    out += grapheme;
    width += w;
  }
  return `${out}…`;
}

// 按显示宽度换行。中文按字断行，英文也不要求在空格处断。
export function wrapText(text, maxWidth) {
  if (maxWidth <= 0) return [String(text ?? "")];
  const lines = [];
  let current = "";
  let currentWidth = 0;
  for (const grapheme of splitGraphemes(text)) {
    const w = graphemeWidth(grapheme);
    if (currentWidth + w > maxWidth && current) {
      lines.push(current);
      current = "";
      currentWidth = 0;
    }
    current += grapheme;
    currentWidth += w;
  }
  if (current) lines.push(current);
  return lines;
}

// 按显示宽度右侧补空格。
export function padEnd(text, width) {
  const str = String(text ?? "");
  const gap = width - displayWidth(str);
  return gap > 0 ? str + " ".repeat(gap) : str;
}

// 按显示宽度左侧补空格。
export function padStart(text, width) {
  const str = String(text ?? "");
  const gap = width - displayWidth(str);
  return gap > 0 ? " ".repeat(gap) + str : str;
}

export function center(text, width) {
  const str = String(text ?? "");
  const gap = width - displayWidth(str);
  if (gap <= 0) return str;
  const left = Math.floor(gap / 2);
  return " ".repeat(left) + str + " ".repeat(gap - left);
}
