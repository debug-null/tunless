// 零依赖文本报告渲染器。
// doctor/status/summary 与 TUI 仪表盘共用 src/core/status-rows.js 的判词；
// 本文件只负责把判词画成终端文本。颜色用 Node 22 自带的 util.styleText，
// 符号集复用 tui/theme.js（纯数据模块，不依赖 ink）。
import { styleText } from "node:util";
import { symbolSet, detectUnicode } from "../tui/theme.js";

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

  return {
    blank() {
      out("");
    },
    section(title) {
      out("");
      out(bold(`── ${title} ──`));
    },
    /** 子系统判词行：`  ✔ 服务   运行中 pid 1 · 按 s 启动` */
    row(status, label, detail = "", action = null) {
      const head = `  ${mark(status)} ${String(label).padEnd(4)}`;
      out(
        paint(status, head) +
          (detail ? ` ${detail}` : "") +
          (action ? dimText(` · ${action}`) : ""),
      );
    },
    /** 自由文本行（带两个空格缩进） */
    line(text = "") {
      out(`  ${text}`);
    },
    /** 次级说明（再缩进、降亮度） */
    dim(text) {
      out(`    ${dimText(text)}`);
    },
    /** 建议动作 */
    suggest(text) {
      out(`    ${dimText(`→ ${text}`)}`);
    },
    /** 顶部总判决 */
    verdict(tone, text) {
      out(paint(tone, ` ● ${text}`));
    },
    /** 直接把 rowsFor(state) 的结果倒出来 */
    rows(rowList) {
      for (const r of rowList) this.row(r.status, r.label, r.detail, r.action);
    },
  };
}
