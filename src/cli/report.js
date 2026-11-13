// 零依赖文本报告渲染器。
// doctor/status/summary 与 TUI 仪表盘共用 src/core/status-rows.js 的判词；
// 本文件只负责把判词画成终端文本。颜色用 Node 22 自带的 util.styleText，
// 符号集与显示宽度复用 tui/theme.js / tui/width.js（纯数据模块，不依赖 ink）。
import { styleText } from "node:util";
import { symbolSet, detectUnicode } from "../tui/theme.js";
import { padEnd } from "../tui/width.js";

const TONE_COLOR = { ok: "green", warn: "yellow", bad: "red", unknown: "gray", info: "cyan" };

export function createReporter({
  color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
  unicode = detectUnicode(),
  out = (line) => console.log(line),
} = {}) {
  const symbols = symbolSet(unicode);
  // color 开关是本模块自己的判断；styleText 默认还会再校验 stdout 是否
  // 支持颜色（管道里直接不上色），这里关掉它免得双重判断。
  const opts = { validateStream: false };
  const paint = (tone, text) =>
    color && TONE_COLOR[tone] ? styleText(TONE_COLOR[tone], text, opts) : text;
  const bold = (t) => (color ? styleText("bold", t, opts) : t);
  const dimText = (t) => (color ? styleText("dim", t, opts) : t);
  const mark = (status) =>
    status === "unknown" ? "?" : (symbols[status] ?? symbols.info);
  const hline = symbols.hline ?? "-";
  const sep = ` ${symbols.dot ?? "."} `;
  const arrow = symbols.arrow ?? ">";
  const bullet = unicode ? "●" : "*";
  const emit = (text) => out(text.replace(/ +$/, ""));

  const api = {
    blank() {
      out("");
    },
    section(title) {
      out("");
      out(bold(`${hline}${hline} ${title} ${hline}${hline}`));
    },
    /** 子系统判词行：`  ✔ 服务   运行中 pid 1 · 按 s 启动` */
    row(status, label, detail = "", action = null) {
      // 6 列：两字中文（4 列宽）和 TUN 这类 3 字母标签的详情列才对齐。
      const head = `  ${mark(status)} ${padEnd(label ?? "", 6)}`;
      emit(
        paint(status, head) +
          (detail ? ` ${detail}` : "") +
          (action ? dimText(`${sep}${action}`) : ""),
      );
    },
    /** 自由文本行（带两个空格缩进） */
    line(text = "") {
      emit(`  ${text}`);
    },
    /** 次级说明（再缩进、降亮度） */
    dim(text) {
      emit(`    ${dimText(text)}`);
    },
    /** 建议动作 */
    suggest(text) {
      emit(`    ${dimText(`${arrow} ${text}`)}`);
    },
    /** 顶部总判决 */
    verdict(tone, text) {
      emit(paint(tone, ` ${bullet} ${text}`));
    },
    /** 直接把 rowsFor(state) 的结果倒出来 */
    rows(rowList = []) {
      for (const r of rowList ?? []) api.row(r.status, r.label, r.detail, r.action);
    },
  };
  return api;
}
