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

// ---- 正在运行的转发服务的「真实状态」----
//
// TUI 第 5 步展示的分流域名、doctor 说的上游，都该以运行中的服务
// 实际加载的配置为准，而不是「刚算出来、还没生效」的那套。proxy
// 启动时把这份快照写下来，界面才能区分「生效中」和「待重启生效」。

export function runtimeFile() {
  return path.join(dataDir(), "runtime.json");
}

// 当前安装的包版本。runtime.json 里记它，CLI/TUI 才能发现
// 「npm 升级了但守护进程还在跑旧代码」——这类漂移之前完全不可见，
// 用户只会觉得「修了怎么还没好」。
let cachedVersion;
export function packageVersion() {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    cachedVersion =
      JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version ??
      null;
  } catch {
    cachedVersion = null;
  }
  return cachedVersion;
}

export function writeRuntime(info) {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(
      runtimeFile(),
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), version: packageVersion(), ...info }, null, 2)}\n`,
      "utf8",
    );
    return true;
  } catch {
    return false;
  }
}

export function readRuntime() {
  try {
    return JSON.parse(fs.readFileSync(runtimeFile(), "utf8"));
  } catch {
    return null;
  }
}

export function clearRuntime() {
  try {
    fs.unlinkSync(runtimeFile());
    return true;
  } catch {
    return false;
  }
}
