// 读取终端当前背景色，决定界面用亮色还是暗色。
//
// 参照 lore（packages/cli/src/termcn/terminal-theme.ts）的做法：
// COLORFGBG / TERM_BACKGROUND 很多现代终端并不设置，
// 所以交互启动时发 OSC 11 查询背景色，按感知亮度选择主题；
// 查询无应答则保持默认回退。

/**
 * 把 `rgb:RR/GG/BB` 或 `#RRGGBB` 解析成 0–255。位数可以是 1–4 位十六进制。
 */
export function parseBackgroundColor(spec) {
  const rgb = /rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(spec);
  if (rgb?.[1] && rgb[2] && rgb[3]) {
    return { r: hexChannel(rgb[1]), g: hexChannel(rgb[2]), b: hexChannel(rgb[3]) };
  }
  const hash = /#([0-9a-f]{6})/i.exec(spec);
  if (hash?.[1]) {
    return {
      r: hexChannel(hash[1].slice(0, 2)),
      g: hexChannel(hash[1].slice(2, 4)),
      b: hexChannel(hash[1].slice(4, 6)),
    };
  }
  return null;
}

/** 从 OSC 11 应答里取出背景色。没有 `]11;` 的杂讯不算应答。 */
export function parseTerminalBackgroundReply(text) {
  const marked = /\]11;([^\x07\x1b]*)/.exec(text);
  if (!marked?.[1]) return null;
  return parseBackgroundColor(marked[1]);
}

/** ITU-R BT.601 感知亮度，阈值 128：亮底用 light，暗底用 dark。 */
export function colorSchemeFromRgb(r, g, b) {
  const y = (r * 299 + g * 587 + b * 114) / 1000;
  return y >= 128 ? "light" : "dark";
}

function hexChannel(hex) {
  const value = Number.parseInt(hex, 16);
  if (Number.isNaN(value)) return 0;
  const max = (1 << hex.length * 4) - 1;
  if (max <= 0) return 0;
  return Math.round((value / max) * 255);
}

/**
 * 向终端询问背景色。非 TTY、测试进程、或超时无应答时返回 null，不改 stdin 模式。
 */
export function queryTerminalColorScheme(timeoutMs = 200) {
  const stdin = process.stdin;
  const stdout = process.stdout;
  if (process.env.NETFIX_TEST === "1") return Promise.resolve(null);
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    const wasRaw = stdin.isRaw;
    const chunks = [];
    let text = "";
    let settled = false;

    const restore = () => {
      stdin.off("data", onData);
      try {
        stdin.setRawMode(Boolean(wasRaw));
      } catch {
        // 某些假 TTY 不允许切 raw mode，查询失败即可。
      }
      stdin.pause();
    };

    const finish = (scheme, leftover) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      restore();
      if (leftover && leftover.length > 0) stdin.unshift(leftover);
      resolve(scheme);
    };

    const onData = (chunk) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      chunks.push(buf);
      text += buf.toString("utf8");
      const color = parseTerminalBackgroundReply(text);
      if (color) {
        finish(colorSchemeFromRgb(color.r, color.g, color.b));
        return;
      }
      if (text.length > 512) finish(null, Buffer.concat(chunks));
    };

    const timer = setTimeout(
      () => finish(null, chunks.length > 0 ? Buffer.concat(chunks) : undefined),
      timeoutMs,
    );

    try {
      stdin.setRawMode(true);
      stdin.pause();
      stdin.on("data", onData);
      stdin.resume();
      stdout.write("\x1b]11;?\x07");
    } catch {
      finish(null);
    }
  });
}

/** 环境变量里显式指定主题时优先，NETFIX_THEME=light|dark */
export function themeFromEnv() {
  const explicit = process.env.NETFIX_THEME?.trim().toLowerCase();
  return explicit === "light" || explicit === "dark" ? explicit : null;
}
