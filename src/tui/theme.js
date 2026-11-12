// 界面配色与符号。
//
// 这里不再自己拼 ANSI 转义序列：ink 的 <Text> 通过 color / dimColor 等属性
// 控制样式，由 ink 统一处理是否启用颜色（NO_COLOR、非 TTY 等）。
// 因此这个文件只保留「语义 → 颜色名」的映射和符号表。

export const SYMBOLS = {
  ok: "✔",
  warn: "▲",
  bad: "✖",
  info: "•",
  arrow: "›",
  dot: "·",
  hline: "─",
};

// 语义色。ink 支持 cyanBright / gray 等颜色名。
export const TONE = {
  ok: "green",
  warn: "yellow",
  bad: "red",
  info: "cyan",
  muted: "gray",
  accent: "cyanBright",
  text: "white",
};

export const BADGE_SYMBOL = {
  ok: SYMBOLS.ok,
  warn: SYMBOLS.warn,
  bad: SYMBOLS.bad,
  info: SYMBOLS.info,
};
