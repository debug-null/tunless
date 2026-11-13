import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToString, Box } from "ink";
import { AppMenu, ACTIONS } from "../src/tui/app-menu.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  APPS,
  findApp,
  applyEnvText,
  codexProxyState,
} from "../src/core/apps.js";

const h = React.createElement;

test("第一级菜单列出 Antigravity 和 Cursor，并标出当前选中项", () => {
  const text = renderToString(
    h(Box, { flexDirection: "column", width: 120 }, h(AppMenu, { width: 120, index: 1, stage: "app" })),
  );
  assert.match(text, /要带代理启动哪个应用/);
  assert.match(text, /Antigravity/);
  assert.match(text, /Cursor/);
  assert.match(text, /回车继续/);
});

test("第二级菜单让用户选择处理方式，含只写配置不启动", () => {
  const app = APPS.find((a) => a.name === "Cursor");
  const text = renderToString(
    h(
      Box,
      { flexDirection: "column", width: 120 },
      h(AppMenu, { width: 120, stage: "action", app, actionIndex: 0 }),
    ),
  );
  assert.match(text, /Cursor 要怎么处理/);
  assert.match(text, /只注入代理环境变量后启动/);
  assert.match(text, /写入代理配置/);
  assert.match(text, /只写入代理配置，不启动/);
  assert.match(text, /回车确认/);
});

test("处理方式覆盖「不改配置」「改配置并启动」「只改配置」三种", () => {
  assert.deepEqual(ACTIONS.map((a) => a.id), ["env", "env+settings", "settings"]);
  // 第一种必须明确说明不会改用户的文件
  assert.match(ACTIONS[0].detail, /不改任何配置文件/);
  for (const action of ACTIONS) {
    assert.ok(action.label && action.detail, `${action.id} 缺少说明`);
  }
});

test("受支持的应用都有说明和定位方式", () => {
  assert.deepEqual(APPS.map((a) => a.name), ["Antigravity", "Cursor", "Codex"]);
  for (const app of APPS) {
    assert.ok(app.description && app.description.length > 0, `${app.name} 缺少说明`);
    // GUI 有 bundle，CLI 有 bin，二者必居其一
    assert.ok(app.bundle || app.bin, `${app.name} 缺少 bundle 名或命令名`);
  }
});

// ---- Codex：代理写在 ~/.codex/.env，而且优先级高于环境变量 ----
// 这是实测出来的：只 export HTTPS_PROXY 没用，Codex 会读 .env 并覆盖。

test("Codex .env 只改三个代理键，其余行原样保留", () => {
  const raw = "# 我自己的注释\nFOO=bar\nHTTP_PROXY=http://old:1\n";
  const next = applyEnvText(raw, {
    HTTP_PROXY: "http://127.0.0.1:8899",
    HTTPS_PROXY: "http://127.0.0.1:8899",
    NO_PROXY: "localhost,127.0.0.1",
  });
  assert.match(next, /# 我自己的注释/);
  assert.match(next, /^FOO=bar$/m);
  assert.match(next, /^HTTP_PROXY=http:\/\/127\.0\.0\.1:8899$/m);
  assert.match(next, /^HTTPS_PROXY=http:\/\/127\.0\.0\.1:8899$/m);
  assert.match(next, /^NO_PROXY=localhost,127\.0\.0\.1$/m);
  // 不能出现重复键
  assert.equal(next.match(/^HTTP_PROXY=/gm).length, 1);
});

test("Codex .env 缺文件时能生成，且以换行结尾", () => {
  const next = applyEnvText("", { HTTPS_PROXY: "http://127.0.0.1:8899" });
  assert.equal(next, "HTTPS_PROXY=http://127.0.0.1:8899\n");
});

test("读 Codex .env 能解析出当前的代理，并识别 8899 是不是已生效", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tunless-codex-"));
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, "HTTP_PROXY=http://127.0.0.1:7897\nHTTPS_PROXY=http://127.0.0.1:8899\n");
  const app = { ...findApp("codex"), configDir: () => dir };
  const state = codexProxyState(app);
  assert.equal(state.httpsProxy, "http://127.0.0.1:8899");
  assert.equal(state.exists, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("Codex 是 CLI，靠 bin 检测安装而不是 .app bundle", () => {
  const codex = findApp("codex");
  assert.ok(codex.bin, "Codex 应该有 bin");
  assert.equal(codex.bundle, undefined, "Codex 没有 .app bundle");
  assert.equal(codex.envOnlyEnough, false, "光给环境变量不够，必须写 .env");
});
