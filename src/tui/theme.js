// 界面配色与符号。
//
// 这里不再自己拼 ANSI 转义序列：ink 的 <Text> 通过 color / dimColor 等属性
// 控制样式，由 ink 统一处理是否启用颜色（NO_COLOR、非 TTY 等）。
//
// 两点参照 lore 的 termcn：
//   1. 亮色终端用亮色主题（白字在白底上看不见）；
//   2. 终端不支持 Unicode 时把符号与边框降级成 ASCII。

/** 暗色终端主题 */
export const DARK_THEME = {
  name: "dark",
  colors: {
    accent: "cyanBright",
    ok: "green",
    warn: "yellow",
    bad: "red",
    info: "cyan",
    muted: "gray",
    text: "white",
    border: "gray",
  },
};

/** 亮色终端主题：白底上用黑字，黄色改用洋红避免看不清 */
export const LIGHT_THEME = {
  name: "light",
  colors: {
    accent: "blue",
    ok: "green",
    warn: "magenta",
    bad: "red",
    info: "cyan",
    muted: "gray",
    text: "black",
    border: "gray",
  },
};

export const THEMES = { dark: DARK_THEME, light: LIGHT_THEME };

export function getTheme(name) {
  return THEMES[name] ?? DARK_THEME;
}

/** Unicode 符号集 */
export const UNICODE_SYMBOLS = {
  ok: "✔",
  warn: "▲",
  bad: "✖",
  info: "•",
  arrow: "›",
  dot: "·",
  hline: "─",
  vline: "│",
};

/** Unicode 边框符号 */
export const UNICODE_BORDERS = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
};

/** ASCII 降级边框符号 */
export const ASCII_BORDERS = {
  topLeft: "+",
  topRight: "+",
  bottomLeft: "+",
  bottomRight: "+",
  horizontal: "-",
  vertical: "|",
};

/** ASCII 降级符号集：终端字体缺字时至少不乱码 */
export const ASCII_SYMBOLS = {
  ok: "+",
  warn: "!",
  bad: "x",
  info: "-",
  arrow: ">",
  dot: ".",
  hline: "-",
  vline: "|",
};

/**
 * 判断终端能否显示 Unicode。
 * TUNLESS_ASCII=1 强制降级；否则看 locale 是否是 UTF-8。
 */
export function detectUnicode() {
  if (process.env.TUNLESS_ASCII === "1") return false;
  // locale 优先级：LC_ALL > LC_CTYPE > LANG
  const locale = [process.env.LC_ALL, process.env.LC_CTYPE, process.env.LANG].find(
    (value) => Boolean(value),
  );
  if (!locale) return true; // macOS 默认就是 UTF-8
  return /utf-?8/i.test(locale);
}

export function symbolSet(unicode) {
  return unicode ? UNICODE_SYMBOLS : ASCII_SYMBOLS;
}

export function borderSet(unicode) {
  return unicode ? UNICODE_BORDERS : ASCII_BORDERS;
}
