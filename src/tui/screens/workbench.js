// 主工作台：状态简报 + 已安装工具列表 + 一键动作。
//
// 简报行直接吃 rowsFor(state) 的判词 —— 和仪表盘、doctor、静态总览同一真相源，
// 不在这一屏另编一套说法（比如永远不写「握手正常」这种没测过的结论）。

import React from "react";
import { Box, Text } from "ink";
import { h, useTheme, useUnicode } from "../ui.js";
import { padEnd, truncate } from "../width.js";
import { symbolSet } from "../theme.js";
import { rowsFor } from "../../core/status-rows.js";

const STATUS_ORDER = ["service", "upstream", "internal"];
const STATUS_LABEL = { service: "转发服务", upstream: "上游代理", internal: "内网分流" };

export function Workbench({
  state,
  appIndex = 0,
  hint = "",
  executing = null,
  width = 80,
}) {
  const theme = useTheme();
  const unicode = useUnicode();
  const symbols = symbolSet(unicode);
  const mark = {
    ok: symbols.ok,
    warn: symbols.warn,
    bad: symbols.bad,
    unknown: "?",
    info: symbols.info,
  };
  const tone = (status) =>
    ({
      ok: theme.colors.ok,
      warn: theme.colors.warn,
      bad: theme.colors.bad,
      unknown: theme.colors.muted,
    })[status] ?? theme.colors.text;

  const side = state.sidecar ?? {};
  const brief = STATUS_ORDER.map((id) =>
    rowsFor(state).find((r) => r.id === id),
  ).filter(Boolean);
  const divider = ` ${symbols.hline.repeat(Math.min(62, Math.max(20, width - 4)))}`;

  // 已安装的工具才是可操作对象 —— 探测中的（installed === undefined）不往里放
  const apps = (state.apps ?? []).filter((a) => a.installed === true);
  const idx = apps.length ? Math.min(appIndex, apps.length - 1) : 0;
  const currentApp = apps[idx];

  const runningText = (app) =>
    app.running
      ? `${unicode ? "●" : "*"} 运行中${app.mainPid ? ` (${app.mainPid})` : ""}`
      : app.id === "codex"
        ? "CLI 工具"
        : `${unicode ? "○" : "-"} 未运行`;

  // proxyVerdict 四态各自说清楚 —— 「没跑/查不到」不等于「没配代理」
  const proxiedText = (app) => {
    if (app.proxied === "ok") {
      return { text: `${symbols.ok} 已代理 (:${side.httpPort ?? 8899})`, color: theme.colors.ok };
    }
    if (app.proxied === "stale") {
      return { text: `${symbols.warn} 还连着旧代理`, color: theme.colors.warn };
    }
    if (app.proxied === "unknown") {
      return { text: "? 代理状态未知", color: theme.colors.muted };
    }
    return { text: "—", color: theme.colors.muted };
  };

  const actionText = (app) =>
    app.proxied === "ok" ? "[回车 实测连通]" : "[回车 一键配置]";

  const detailFor = (app) => {
    if (executing) return `正在执行：${executing}…`;
    if (app.proxied === "ok") {
      return `已走 tunless 代理（127.0.0.1:${side.httpPort ?? 8899}），回车实测连通性，不通再按一次重启修复`;
    }
    if (app.proxied === "stale") return "还连着旧代理，回车改走 tunless 并重启";
    if (app.id === "codex") {
      return "回车把代理写入 ~/.codex/.env（终端与桌面客户端共用）";
    }
    return "回车配置代理并受控重启";
  };

  const hintColor = /✔|\+/.test(hint)
    ? theme.colors.ok
    : /✖|失败|没能|不通|x /.test(hint)
      ? theme.colors.bad
      : theme.colors.warn;

  return h(
    Box,
    { flexDirection: "column" },

    // 顶栏
    h(
      Box,
      { marginBottom: 1 },
      h(Text, { bold: true, color: theme.colors.accent }, " tunless "),
      h(Text, { dimColor: true }, "· 让 AI Agent 免开 TUN 也能正常联网与内网分流"),
    ),

    // 状态简报：判词来自 rowsFor，详情原样透出（截断到终端宽，不再折行碎字）
    h(
      Box,
      { flexDirection: "column", marginBottom: 1, paddingLeft: 1 },
      brief.map((row) =>
        h(
          Box,
          { key: row.id },
          h(Text, { dimColor: true }, padEnd(STATUS_LABEL[row.id], 5)),
          h(
            Text,
            { color: tone(row.status), bold: row.status !== "unknown" },
            truncate(`${mark[row.status] ?? "?"} ${row.detail ?? ""}`, Math.max(10, width - 12)),
          ),
        ),
      ),
    ),

    h(Text, { dimColor: true }, divider),

    // 工具列表
    h(
      Box,
      { flexDirection: "column", marginY: 1, paddingLeft: 1 },
      apps.length === 0
        ? h(Text, { dimColor: true }, "未检测到已安装的 Antigravity / Cursor / Codex")
        : apps.map((app, i) => {
            const isCurrent = i === idx;
            const p = proxiedText(app);
            return h(
              Box,
              { key: app.id ?? app.name },
              h(
                Text,
                { color: isCurrent ? theme.colors.accent : undefined, bold: isCurrent },
                isCurrent ? `${symbols.arrow} ` : "  ",
              ),
              h(
                Text,
                { bold: isCurrent, color: isCurrent ? theme.colors.accent : undefined },
                padEnd(app.name, 16),
              ),
              h(
                Text,
                { color: app.running ? theme.colors.ok : undefined, dimColor: !app.running },
                padEnd(runningText(app), 18),
              ),
              h(Text, { color: p.color, bold: isCurrent }, padEnd(p.text, 18)),
              h(Text, { dimColor: !isCurrent, bold: isCurrent }, actionText(app)),
            );
          }),

      currentApp
        ? h(
            Box,
            { marginTop: 1, paddingLeft: 2 },
            h(Text, { dimColor: true }, `${symbols.arrow} ${currentApp.name}: `),
            h(
              Text,
              null,
              truncate(
                detailFor(currentApp),
                Math.max(10, width - currentApp.name.length - 6),
              ),
            ),
          )
        : null,

      // 动作结果回显 —— hint 曾经被收下但没渲染，成功失败全都看不见
      hint && !executing
        ? h(
            Box,
            { paddingLeft: 2 },
            h(Text, { color: hintColor }, hint),
          )
        : null,
    ),

    h(Text, { dimColor: true }, divider),
  );
}
