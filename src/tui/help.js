// 面向不了解这个项目的人：说明 tunless 是什么、给谁用、怎么用。
//
// 这些内容同时也是 README「怎么用」那一节的来源，避免两边说法不一致。

import { Box, Text } from "ink";
import { h, Card, kv, txt, useTheme } from "./ui.js";

/** 转发服务的默认地址，界面里要明确告诉用户「代理填这里」 */
export const PROXY_INFO = {
  http: "http://127.0.0.1:8899",
  socks: "socks5://127.0.0.1:8898",
};

/**
 * 根据当前状态给出「下一步该做什么」。
 * 用户最常见的问题不是「诊断结果是什么」，而是「所以我现在该按哪个键」。
 */
export function nextSteps(state, opts = {}) {
  // 一个界面一次只该告诉用户「下一步做这一件事」。
  // 之前把所有问题堆在一起，用户反而不知道先按哪个。
  if (!state.core.reachable) {
    return [{ key: "", text: "代理内核连不上：先确认 Clash Verge 正在运行" }];
  }

  if (!state.sidecar.installed) {
    return [{ key: "s", text: "第一步：按 s 装好转发服务（之后它会开机自启）" }];
  }

  if (!state.sidecar.running) {
    return [{ key: "s", text: "转发服务没在跑，按 s 启动它" }];
  }

  if (state.fakeCount > 0) {
    return [{ key: "f", text: `${state.fakeCount} 个内网域名拿到假 IP，按 f 修一下` }];
  }

  const nextApp = opts.nextApp ?? "Antigravity";
  return [
    {
      key: "l",
      text: `转发服务已就绪：按 l 用代理重启 ${nextApp}（再按一次换另一个应用）`,
    },
    { key: "a", text: "有扫不到的内网域名，按 a 直接手写一条" },
  ];
}

/** 键名 + 说明，排成一行 */
function stepRow(step) {
  const label = step.key ? `按 ${step.key}` : "说明";
  return kv(label, [txt(step.text)], 8);
}

export function HelpPanel({ width }) {
  const theme = useTheme();
  const cardWidth = Math.min(width, 78);

  const whatRows = [
    kv("解决的问题", [txt("Agent 不开 TUN 就联不上网")], 12),
    [txt("  ")],
    kv("", [txt("Antigravity / Cursor / CLI Agent 只认 HTTPS_PROXY，")], 12),
    kv("", [txt("或者干脆忽略代理设置，过去只能开 TUN")], 12),
    kv("", [txt("开了 TUN 内网域名又被劫持，公司内网就连不上")], 12),
    [txt("  ")],
    kv("这个工具", [txt("给你一个本地代理，让 Agent 不靠 TUN 也能出网")], 12),
  ];

  const stepsRows = [
    kv("第 1 步", [txt("按 s 装好转发服务（监听 127.0.0.1:8899）")], 10),
    kv("第 2 步", [txt("按 l 用代理重启应用，按一次换一个（Antigravity → Cursor）")], 10),
    kv("第 3 步", [txt("内网域名扫不到？按 a 直接手写，不用给任何权限")], 10),
    [txt("  ")],
    kv("Cursor 用户", [txt("按 L 走 Cursor 专用流程：改设置 + 关 HTTP/2 + 重启")], 10),
  ];

  const proxyRows = [
    kv("HTTP 代理", [txt(PROXY_INFO.http)], 12),
    kv("SOCKS5 代理", [txt(PROXY_INFO.socks)], 12),
    [txt("  ")],
    kv("手动填的话", [txt("在应用的代理设置里填 127.0.0.1 : 8899")], 12),
    kv("", [txt("或启动应用前加上 HTTPS_PROXY=http://127.0.0.1:8899")], 12),
  ];

  const tunRows = [
    kv("什么时候开", [txt("只有完全无法走代理的工具才需要")], 12),
    kv("", [txt("开了 TUN 内网域名会被劫持，这也是本工具想避免的")], 12),
  ];

  const cmdRows = [
    kv("tunless doctor", [txt("只诊断，不改任何东西")], 24),
    kv("tunless cursor", [txt("给 Cursor 配好代理并重启（模型连不上用这个）")], 24),
    kv("tunless rules add", [txt("手动补内网域名 / 关键词 / IP 段")], 24),
    kv("tunless fix", [txt("生成并应用 DNS 分流修复")], 24),
    kv("tunless launch", [txt("带代理重启某个应用")], 24),
  ];

  return h(
    Box,
    { flexDirection: "column" },
    h(Card, { title: "这是什么", width: cardWidth, rows: whatRows }),
    h(Card, { title: "怎么用（三步）", width: cardWidth, rows: stepsRows }),
    h(Card, { title: "代理填什么", width: cardWidth, rows: proxyRows }),
    h(Card, { title: "什么时候才需要 TUN", width: cardWidth, rows: tunRows }),
    h(Card, { title: "命令行用法", width: cardWidth, rows: cmdRows }),
  );
}
