// 这份 chalk 的 supports-color 不读 NO_COLOR，只在加载时看 FORCE_COLOR。
// 必须在 ink / chalk 被 import 之前执行，否则 PTY 上 NO_COLOR=1 仍会输出 SGR。
if (typeof process.env.NO_COLOR === "string" && process.env.NO_COLOR !== "") {
  process.env.FORCE_COLOR = "0";
}
