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
export function nextSteps(state) {
  const steps = [];

  if (!state.core.reachable) {
    steps.push({
      key: "",
      text: "代理内核连不上：先确认 Clash Verge Rev 正在运行",
    });
  }

  if (!state.sidecar.installed) {
    steps.push({
      key: "S",
      text: "转发服务还没装，按 S 安装并启动它（会监听 127.0.0.1:8899）",
    });
  } else if (!state.sidecar.running) {
    steps.push({
      key: "S",
      text: "转发服务没在跑，按 S 启动它（会监听 127.0.0.1:8899）",
    });
  } else {
    steps.push({
      key: "l",
      text: "转发服务已在运行，用它重启 Antigravity，应用就会走代理",
    });
  }

  const unsupported = state.processes.filter((p) => p.status === "unsupported");
  if (unsupported.length) {
    steps.push({
      key: "",
      text: `${unsupported.length} 个运行中的程序不支持代理（比如 ${unsupported[0].comm}），只能靠 tunless 转发，或者开 TUN`,
    });
  }

  if (state.fakeCount > 0) {
    steps.push({
      key: "f",
      text: `${state.fakeCount} 个域名还拿到假 IP 地址，生成并应用修复方案`,
    });
  }

  if (state.internalDomains.length > 0) {
    steps.push({
      key: "",
      text: `${state.internalDomains.length} 个内网域名解析正确，走直连，不经过代理`,
    });
  }

  if (!steps.length) {
    steps.push({ key: "", text: "一切正常，不需要做任何操作" });
  }
  return steps;
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
    kv("第 1 步", [txt("按 S 安装／启动转发服务，监听 127.0.0.1:8899")], 10),
    kv("第 2 步", [txt("按 l 用这个代理重启 Agent（默认 Antigravity）")], 10),
    kv("第 3 步", [txt("内网域名解析不对时按 f 生成并应用修复")], 10),
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
    kv("tunless doctor", [txt("只诊断，不改任何东西")], 22),
    kv("tunless scan", [txt("列出扫到的内网域名")], 22),
    kv("tunless fix", [txt("生成并应用修复方案")], 22),
    kv("tunless launch", [txt("带代理重启某个应用")], 22),
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
