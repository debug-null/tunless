// 用户数据目录。
//
// 早期版本叫 netfix，数据放在 ~/.netfix。改名成 tunless 后，
// 首次运行时如果旧目录还在、新目录还没建，就把旧目录整体搬过来，
// 这样备份、日志和「已看过引导」的标记都不会丢。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const APP_NAME = "tunless";
const LEGACY_NAME = "netfix";

function home() {
  return os.homedir();
}

function moveLegacyDir() {
  const legacy = path.join(home(), `.${LEGACY_NAME}`);
  const next = path.join(home(), `.${APP_NAME}`);
  if (!fs.existsSync(legacy) || fs.existsSync(next)) return;
  try {
    fs.renameSync(legacy, next);
  } catch {
    // 跨设备或权限问题时不强行搬运，退回使用旧目录
    try {
      fs.cpSync(legacy, next, { recursive: true });
    } catch {
      // 搬不动就算了，用户数据留在旧位置也能继续工作
    }
  }
}

/** 用户数据目录，必要时把旧版本的目录迁过来 */
export function dataDir() {
  moveLegacyDir();
  return path.join(home(), `.${APP_NAME}`);
}

/** 旧版本的目录，迁移失败时还能读到历史备份 */
export function legacyDataDir() {
  return path.join(home(), `.${LEGACY_NAME}`);
}
