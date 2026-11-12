// 首次运行的判断。
//
// 第一次用这个工具的人多半不知道从哪开始，所以首次启动直接打开「怎么用」面板；
// 看过之后在 ~/.netfix/seen 记一笔，之后仍然从总览进入。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MARKER = path.join(os.homedir(), ".netfix", "seen");

export function isFirstRun() {
  try {
    return !fs.existsSync(MARKER);
  } catch {
    return false;
  }
}

export function markSeen() {
  try {
    fs.mkdirSync(path.dirname(MARKER), { recursive: true });
    fs.writeFileSync(MARKER, `${new Date().toISOString()}\n`);
  } catch {
    // 写不了也不影响使用
  }
}
