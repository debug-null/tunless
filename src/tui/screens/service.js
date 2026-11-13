// 服务与日志屏：转发服务一张状态卡 + 可回看的完整事件流。
// 顶行判词与仪表盘同出处（status-rows.js），本屏补 runtime.json 的运行时细节：
// 跑着的进程实际加载了什么，而不是「刚算出来、还没生效」的那套。
import { Box, Text } from "ink";
import { h, useTheme, txt, segments, kv, Section } from "../ui.js";
import { rowsFor } from "../../core/status-rows.js";
import { StatusRow } from "../components/status-row.js";
import { EventFeed } from "../components/event-feed.js";

export function ServiceScreen({ state, width = 80, events = [], eventScroll = 0, rows = 24 }) {
  const theme = useTheme();
  const s = state?.sidecar ?? {};
  const serviceRow = rowsFor(state).find((r) => r.id === "service");
  const runtime = s.runtime ?? null;

  // startedAt 是 writeRuntime 落盘的 ISO 串，屏上只留 HH:mm:ss。
  const started = runtime?.startedAt ? new Date(runtime.startedAt) : null;
  const startedText =
    started && !Number.isNaN(started.getTime()) ? started.toTimeString().slice(0, 8) : null;
  const upstreamText = runtime?.upstream?.host
    ? `${runtime.upstream.host}:${runtime.upstream.port}`
    : null;
  const active = s.activeSuffixes?.length ?? 0;
  const pending = s.pendingSuffixes?.length ?? 0;

  const statusLines = [
    kv(
      "状态",
      [
        state?.loading
          ? txt("探测中", { dim: true })
          : s.running
            ? txt(`运行中${s.pid ? ` · pid ${s.pid}` : ""}`, { color: theme.colors.ok })
            : s.installed
              ? txt("已停止 · 按 s 启动", { color: theme.colors.bad })
              : txt("未安装 · 按 g 进向导装上", { color: theme.colors.warn }),
      ],
      8,
    ),
    // 「端口」而不是「监听中」：服务没跑时这也是它起来后要占的口，如实写。
    kv(
      "端口",
      [txt(`HTTP :${s.httpPort ?? 8899}${s.socksPort ? ` · SOCKS :${s.socksPort}` : ""}`)],
      8,
    ),
  ];

  if (s.running) {
    if (runtime) {
      // runtime.json 是服务启动那一刻写下的快照：它加载的上游与后缀数
      // 以这份为准，pending 后缀要重启才会进来。
      if (startedText) statusLines.push(kv("启动于", [txt(startedText)], 8));
      statusLines.push(
        kv("上游", upstreamText ? [txt(upstreamText)] : [txt("读不到", { dim: true })], 8),
      );
      statusLines.push(
        kv(
          "分流",
          [
            txt(`${active} 个后缀生效中`, { color: theme.colors.ok }),
            pending
              ? txt(` · 还有 ${pending} 个待生效 · s 重启生效`, { color: theme.colors.warn })
              : null,
          ].filter(Boolean),
          8,
        ),
      );
    } else {
      // 跑着却没快照：多半是服务不是从这个版本起的。
      // 不拿刚算出的后缀冒充「生效中」—— 那正好是仪表盘要消掉的谎话。
      statusLines.push(kv("分流", [txt("运行快照读不到（runtime.json）", { dim: true })], 8));
    }
  }

  // 事件窗口：eventScroll 是「从尾部往回翻了多少条」，0 = 贴最新。
  // 实现上先在屏里把数组切好（砍尾部 scroll 条 → 取最后 limit 条），
  // EventFeed 保持「渲染最后 limit 条」的简单语义，不用为它加参数。
  const limit = Math.max(5, rows - 14);
  const end = Math.max(0, events.length - eventScroll);
  const view = events.slice(0, end).slice(-limit);
  const earlier = Math.max(0, end - view.length); // 窗口之上还压着多少条更早的

  return h(
    Box,
    { flexDirection: "column" },
    h(Text, { color: theme.colors.accent, bold: true }, " 服务"),
    h(Text, null, " "),
    h(StatusRow, { row: serviceRow, selected: false, width }),
    h(
      Section,
      { title: "状态" },
      ...statusLines.map((line, i) => h(Text, { key: i }, ...segments(line))),
    ),
    h(
      Section,
      { title: "事件" },
      view.length
        ? h(EventFeed, { events: view, limit })
        : h(Text, { dimColor: true }, "  还没有事件"),
      eventScroll > 0
        ? h(
            Text,
            { dimColor: true },
            `  ↑↓ 滚动 · ${earlier ? `还有 ${earlier} 条更早` : "已是最早"}`,
          )
        : null,
    ),
  );
}
