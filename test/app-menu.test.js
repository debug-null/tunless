import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToString, Box } from "ink";
import { AppMenu, ACTIONS } from "../src/tui/app-menu.js";
import { APPS } from "../src/core/apps.js";

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

test("受支持的应用只有 Antigravity 和 Cursor，且都有说明", () => {
  assert.deepEqual(APPS.map((a) => a.name), ["Antigravity", "Cursor"]);
  for (const app of APPS) {
    assert.ok(app.description && app.description.length > 0, `${app.name} 缺少说明`);
    assert.ok(app.bundle, `${app.name} 缺少 bundle 名`);
  }
});
