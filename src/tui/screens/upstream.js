// 上游代理屏：探测出来的代理候选 + 手动填写通道。
//
// 同一份内容渲染服务两个语境：
//   embedded=true  向导第 2 步（StepFrame 卡片外框，「第 2 步 / 共 5 步」）
//   embedded=false 仪表盘钻取屏（屏名 + StatusRow + Section）
// 只写一份内容行，两边不会各自漂移。
//
// 候选列表来自真实探测（系统代理 / mihomo API / 本机监听端口，且都验过协议），
// 探测不到就让用户直接写 —— 不要假装「没检测到 = 一定没有」。
import { Box, Text } from "ink";
import { h, useTheme, txt, segments, Section, optionRow } from "../ui.js";
import { StepFrame } from "../step-frame.js";
import { rowsFor } from "../../core/status-rows.js";
import { StatusRow } from "../components/status-row.js";

/**
 * 内容行（Card 的段格式，Section 也逐行渲染同一批）：
 * 手填输入 → 空态引导 → 候选列表，末尾补 pinned / 正在验证 两行状态。
 */
function contentRows(theme, { state, index, pinned, editing, draft, verifying, verifyResult }) {
  const rows = [];
  const candidates = state.upstream?.candidates ?? [];

  if (editing) {
    rows.push([
      txt("  代理地址 ", { bold: true }),
      txt(draft || "", { color: theme.colors.accent }),
      txt("█", { color: theme.colors.accent }),
    ]);
    rows.push([txt("  ")]);
    rows.push([
      txt("  "),
      txt("回车确认 · Esc 取消 · 例：127.0.0.1:7897", { dim: true }),
    ]);
    if (verifyResult) {
      rows.push([txt("  ")]);
      rows.push([
        txt("  "),
        verifyResult.ok
          ? txt(`✔ ${verifyResult.detail}`, { color: theme.colors.ok })
          : txt(`✖ ${verifyResult.detail}`, { color: theme.colors.bad }),
      ]);
    }
    return rows;
  }

  if (!candidates.length) {
    rows.push([txt("  "), txt("没探测到可用的代理", { color: theme.colors.warn })]);
    rows.push([txt("  ")]);
    rows.push([
      txt("  "),
      txt("先打开你的代理客户端（Clash / Surge / Stash / sing-box 都行）", { dim: true }),
    ]);
    rows.push([txt("  "), txt("按 m 直接填端口，或回车重新探测", { dim: true })]);
  } else {
    const widthName = Math.max(...candidates.map((c) => `${c.host}:${c.port}`.length)) + 2;
    candidates.forEach((c, i) => {
      const addr = `${c.host}:${c.port}`;
      const proto = (c.protocols ?? []).join("+") || "未知";
      rows.push(optionRow(theme, i === index, addr, `${c.label ?? ""} · ${proto}`, widthName));
    });
    rows.push([txt("  ")]);
    rows.push([txt("  "), txt("m 手动填一个端口", { dim: true })]);
  }

  if (pinned) {
    rows.push([txt("  ")]);
    rows.push([
      txt("  "),
      txt(`当前固定使用 ${pinned.host}:${pinned.port}`, { dim: true }),
    ]);
  }
  if (verifying) {
    rows.push([txt("  "), txt("正在验证这个代理能不能出网…", { dim: true })]);
  }
  return rows;
}

export function UpstreamScreen({
  state,
  index = 0,
  pinned,
  editing = false,
  draft = "",
  verifying = false,
  verifyResult = null,
  width = 80,
  embedded = false,
  // 下面三个只有 embedded 时才用，由 StepUpstream 钉死（第 2 步 / 共 5 步）
  step = 2,
  total = 5,
  title = "代理要从哪个端口出去",
}) {
  const theme = useTheme();
  const rows = contentRows(theme, {
    state,
    index,
    pinned,
    editing,
    draft,
    verifying,
    verifyResult,
  });

  if (embedded) {
    return h(StepFrame, {
      step,
      total,
      title,
      width,
      rows,
      footer: editing
        ? "输入代理的 host:port，回车确认"
        : "↑↓ 选择 · 回车确认 · m 手动填写 · Esc 上一步",
    });
  }

  const upstreamRow = rowsFor(state).find((r) => r.id === "upstream") ?? {
    status: "unknown",
    label: "上游",
    detail: "",
  };
  const lines = rows.map((line, i) => h(Text, { key: i }, ...segments(line)));
  // 候选验证失败要在屏上留证据：这屏底栏是事件流不是 hint，
  // 只靠事件流的话失败原因滚两下就没了。
  if (!editing && verifyResult && !verifyResult.ok) {
    lines.push(
      h(
        Text,
        { key: "verify-fail", color: theme.colors.bad },
        `  ✖ ${verifyResult.detail}`,
      ),
    );
  }

  return h(
    Box,
    { flexDirection: "column" },
    h(Text, { color: theme.colors.accent, bold: true }, " 上游代理"),
    h(Text, null, " "),
    // 行内 action（按 u 确认）是仪表盘语境，本屏按键看底部 KeyBar。
    h(StatusRow, { row: { ...upstreamRow, action: null }, selected: false, width }),
    h(
      Section,
      { title: editing ? "手动填写" : "代理候选" },
      ...lines,
    ),
  );
}
