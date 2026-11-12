// 按键解析：把终端的原始输入转成语义化按键事件。
// 兼容带方向键的终端序列（ESC [ A/B/C/D）。

const ESC = "\x1b";

export function createKeyParser(onKey) {
  let buffer = "";

  const handler = (chunk) => {
    buffer += chunk;
    let guard = 0;
    while (buffer.length && guard < 50) {
      guard += 1;

      if (buffer.startsWith(`${ESC}[`) || buffer.startsWith(`${ESC}O`)) {
        const match = /^\x1b[\[]?([A-Za-z0-9;~])/.exec(buffer);
        if (!match) break;
        const code = match[1];
        buffer = buffer.slice(match[0].length);
        const named = {
          A: "up",
          B: "down",
          C: "right",
          D: "left",
          H: "home",
          F: "end",
        };
        if (named[code]) {
          onKey({ name: named[code] });
          continue;
        }
        if (code === "~") {
          const nums = /^\x1b\[\d+~/.exec(chunk);
          if (nums) {
            const n = Number(/\[(\d+)/.exec(nums)[1]);
            const map = { 1: "home", 2: "insert", 3: "delete", 4: "end", 5: "pageup", 6: "pagedown" };
            if (map[n]) onKey({ name: map[n] });
            continue;
          }
        }
        continue;
      }

      if (buffer.startsWith(ESC)) {
        buffer = buffer.slice(1);
        onKey({ name: "escape" });
        continue;
      }

      const char = buffer[0];
      buffer = buffer.slice(1);
      if (char === "\r" || char === "\n") {
        onKey({ name: "enter" });
        continue;
      }
      if (char === "\t") {
        onKey({ name: "tab" });
        continue;
      }
      if (char === "\x7f" || char === "\b") {
        onKey({ name: "backspace" });
        continue;
      }
      if (char === "\x03") {
        onKey({ name: "ctrl-c" });
        continue;
      }
      if (char < " ") {
        onKey({ name: "ctrl", ctrl: char });
        continue;
      }
      onKey({ name: "char", char });
    }
  };

  return { handler, flush: () => { buffer = ""; } };
}
