// 终端配色与符号。中文界面里符号要和文字分开考虑宽度，
// 这里统一提供，保证所有面板风格一致。

const enabled = process.stdout.isTTY && !process.env.NO_COLOR;

const CODES = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  reverse: "\x1b[7m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  brightRed: "\x1b[91m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightBlue: "\x1b[94m",
  brightMagenta: "\x1b[95m",
  brightCyan: "\x1b[96m",
};

export const SYMBOLS = {
  ok: "✔",
  warn: "▲",
  bad: "✖",
  info: "•",
  arrow: "›",
  dot: "·",
  branch: "├─",
  lastBranch: "╰─",
  vertical: "│",
  hline: "─",
};

export function paint(code, text) {
  return enabled ? `${CODES[code]}${text}${CODES.reset}` : String(text);
}

export const c = {
  reset: (t) => paint("reset", t),
  bold: (t) => paint("bold", t),
  dim: (t) => paint("dim", t),
  underline: (t) => paint("underline", t),
  reverse: (t) => paint("reverse", t),
  red: (t) => paint("red", t),
  green: (t) => paint("green", t),
  yellow: (t) => paint("yellow", t),
  blue: (t) => paint("blue", t),
  magenta: (t) => paint("magenta", t),
  cyan: (t) => paint("cyan", t),
  gray: (t) => paint("gray", t),
  brightRed: (t) => paint("brightRed", t),
  brightGreen: (t) => paint("brightGreen", t),
  brightYellow: (t) => paint("brightYellow", t),
  brightCyan: (t) => paint("brightCyan", t),
  white: (t) => paint("white", t),
};

// 状态徽标：正常 / 警告 / 失败 / 信息
export const badge = {
  ok: (t) => c.green(SYMBOLS.ok) + (t ? ` ${t}` : ""),
  warn: (t) => c.yellow(SYMBOLS.warn) + (t ? ` ${t}` : ""),
  bad: (t) => c.red(SYMBOLS.bad) + (t ? ` ${t}` : ""),
  info: (t) => c.cyan(SYMBOLS.info) + (t ? ` ${t}` : ""),
  dim: (t) => c.gray(t),
};

export const colorEnabled = enabled;
