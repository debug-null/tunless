// 「内网规则」面板：显示自动扫到的内网域名 + 用户手动补充的规则。
//
// 这是给「不敢给终端完全磁盘访问权限」的人准备的退路：
// 不用授权、不用改配置文件，直接输入域名或 IP 段就行。

import { Box, Text } from "ink";
import { h, Card, kv, txt, useTheme, Badge, Section } from "./ui.js";
import { padEnd, truncate } from "./width.js";
import { RULE_KINDS } from "../core/rules.js";

const KIND_LABEL = {
  domain: "域名后缀",
  keyword: "关键词",
  cidr: "IP 段",
};

const KIND_HINT = {
  domain: "子域名自动覆盖，例：17usoft.com",
  keyword: "域名里含这个词就走直连，例：jira",
  cidr: "解析到这个段就走直连，例：10.0.0.0/8",
};

function flatTotal(rules) {
  return RULE_KINDS.reduce((sum, kind) => sum + (rules?.[kind]?.length ?? 0), 0);
}

export function RulesPanel({ state, width, height, scroll, editing, draft, ruleIndex = 0 }) {
  const theme = useTheme();
  const cardWidth = Math.max(56, Math.min(width - 2, 110));
  const rules = state.rules ?? { domain: [], keyword: [], cidr: [] };

  // 编辑状态：一条输入行 + 三个可选类型
  if (editing) {
    const rows = [
      kv("输入", [txt(draft + "▏")], 8),
      [txt("  ")],
      kv("类型", [txt(KIND_LABEL[editing], { bold: true })], 8),
      kv("说明", [txt(KIND_HINT[editing], { dim: true })], 8),
      [txt("  ")],
      kv("", [txt("回车保存 · Tab 切换类型 · Esc 取消", { dim: true })], 8),
    ];
    return h(
      Box,
      { flexDirection: "column" },
      h(Card, { title: "加一条内网规则", width: cardWidth, rows }),
    );
  }

  const autoRows = state.internalDomains.length
    ? state.internalDomains.slice(0, 8).map((d) => kv("", [txt(d.name), txt("  "), txt(d.ips[0] ?? "", { dim: true })], 2))
    : [kv("", [txt("没有扫到（多半是没给终端完全磁盘访问权限）", { dim: true })], 2)];
  if (state.internalDomains.length > 8) {
    autoRows.push(kv("", [txt(`…… 还有 ${state.internalDomains.length - 8} 个`, { dim: true })], 2));
  }

  const manualRows = [];
  const flat = [];
  for (const kind of RULE_KINDS) {
    const list = rules[kind] ?? [];
    if (!list.length) continue;
    manualRows.push(kv("", [txt(KIND_LABEL[kind], { bold: true })], 2));
    for (const value of list) {
      const index = flat.length;
      flat.push({ kind, value });
      const selected = index === ruleIndex % Math.max(1, flatTotal(rules));
      manualRows.push(
        kv(
          selected ? "›" : "",
          [txt(`  ${value}`, { bold: selected, color: selected ? theme.colors.accent : undefined })],
          2,
        ),
      );
    }
  }
  if (!manualRows.length) {
    manualRows.push(kv("", [txt("还没有手动规则", { dim: true })], 2));
  }

  return h(
    Box,
    { flexDirection: "column" },
    h(Card, {
      title: "自动扫描到的内网域名",
      width: cardWidth,
      rows: autoRows,
    }),
    h(Card, {
      title: "你手动补充的规则",
      width: cardWidth,
      rows: manualRows,
    }),
    h(Card, {
      title: "怎么用",
      width: cardWidth,
      rows: [
        kv("a", [txt("加一条（域名 / 关键词 / IP 段）")], 6),
        kv("j / k", [txt("上下移动选中的规则")], 6),
        kv("d", [txt("删掉选中的规则")], 6),
        [txt("  ")],
        kv("", [txt("扫不到的域名，手写一条就能走直连，不需要任何授权。", { dim: true })], 6),
      ],
    }),
  );
}

/** 「更多」面板：把原来分散的五六个面板收进来，不占主流程 */
export function MorePanel({ state, width }) {
  const theme = useTheme();
  const cardWidth = Math.max(56, Math.min(width - 2, 110));
  const symbols = state.core.reachable ? "内核正常" : "内核不可达";

  const procRows = state.processes.length
    ? state.processes.slice(0, 10).map((p) => {
        const label = p.status === "supported" ? "支持" : p.status === "unsupported" ? "不支持" : "未知";
        return kv("", [txt(padEnd(truncate(p.comm, 46), 46)), txt(label)], 2);
      })
    : [kv("", [txt("未发现相关进程", { dim: true })], 2)];

  const routeRows = state.suffixes.length
    ? state.suffixes.map((s) => kv("", [txt(`+.${s}`)], 2))
    : [kv("", [txt("无", { dim: true })], 2)];

  return h(
    Box,
    { flexDirection: "column" },
    h(Card, {
      title: "程序代理能力",
      width: cardWidth,
      rows: procRows,
    }),
    h(Card, {
      title: `分流后缀（共 ${state.suffixes.length}）`,
      width: cardWidth,
      rows: routeRows.slice(0, 12),
    }),
    h(Card, {
      title: "环境",
      width: cardWidth,
      rows: [
        kv("内核", [txt(symbols)], 8),
        kv("转发服务", [txt(state.sidecar.running ? `运行中 (pid ${state.sidecar.pid})` : "未运行")], 8),
        kv("域名扫描", [txt(`内网 ${state.internalDomains.length} · 公网 ${state.publicCount} · 未解析 ${state.unresolvedCount}`)], 8),
      ],
    }),
  );
}
