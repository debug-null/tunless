import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToString, Box } from "ink";
import { AppMenu } from "../src/tui/app-menu.js";
import { APPS } from "../src/core/apps.js";

const h = React.createElement;

test("应用菜单列出 Antigravity 和 Cursor，并标出当前选中项", () => {
  const text = renderToString(
    h(Box, { flexDirection: "column", width: 120 }, h(AppMenu, { width: 120, index: 1 })),
  );
  assert.match(text, /要带代理启动哪个应用/);
  assert.match(text, /Antigravity/);
  assert.match(text, /Cursor/);
  assert.match(text, /回车启动/);
});

test("受支持的应用只有 Antigravity 和 Cursor，且都有说明", () => {
  assert.deepEqual(APPS.map((a) => a.name), ["Antigravity", "Cursor"]);
  for (const app of APPS) {
    assert.ok(app.description && app.description.length > 0, `${app.name} 缺少说明`);
    assert.ok(app.bundle, `${app.name} 缺少 bundle 名`);
  }
});
