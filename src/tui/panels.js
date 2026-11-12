// 各个面板的绘制逻辑。每个面板返回一个字符串行数组。

import { c, badge, SYMBOLS } from "./theme.js";
import { padEnd, padStart, truncate, displayWidth } from "./width.js";

export const PANELS = [
  { id: "overview", name: "总览", key: "1" },
  { id: "domains", name: "内网域名", key: "2" },
  { id: "processes", name: "程序代理能力", key: "3" },
  { id: "routes", name: "分流规则", key: "4" },
  { id: "events", name: "操作日志", key: "5" },
];

export function panelTitle(text, width) {
  const label = ` ${text} `;
  const left = c.bold(c.brightCyan(label));
  const used = displayWidth(label) + 4;
  const line = width > used ? SYMBOLS.hline.repeat(width - used) : "";
  return `${left} ${c.dim(line)}`;
}

function kv(label, value, labelWidth = 14, width = 0) {
  const head = `  ${padEnd(c.dim(label), labelWidth + 10)}`;
  if (width > 0) {
    const room = width - displayWidth(head);
    if (room > 4) {
      return head + truncate(value, room);
    }
  }
  return `${head}${value}`;
}

export function renderOverview(state, width) {
  const lines = [];
  lines.push(panelTitle("代理内核", width));

  const core = state.core;
  if (core.reachable) {
    lines.push(kv("客户端", `${c.cyan(state.frontend?.label ?? "未知")}`, 14, width));
    lines.push(kv("内核版本", `${core.version ?? "未知"}  ${c.dim(`(${state.core.mode ?? "-"} 模式)`)}`, 14, width));
    lines.push(
      kv("混合端口", core.mixedPort ? `${core.mixedPort}` : c.dim("未开放"), 14, width),
    );
    lines.push(
      kv(
        "TUN 模式",
        core.tun
          ? badge.ok("已开启")
          : `${badge.warn("已关闭")} ${c.dim("仅完全忽略代理的程序需要它")}`,
        14,
        width,
      ),
    );
  } else {
    lines.push(kv("状态", badge.bad("内核不可达")));
    for (const e of state.errors.slice(0, 3)) lines.push(kv("", c.red(e)));
  }

  const sys = state.systemProxy;
  if (sys) {
    lines.push(
      kv(
        "系统代理",
        sys.httpEnabled && sys.httpsEnabled
          ? badge.ok(`已启用 ${sys.host}:${sys.port}`)
          : badge.warn("未启用"),
        14,
        width,
      ),
    );
  }

  const side = state.sidecar;
  lines.push(
    kv(
      "转发服务",
      side.running ? badge.ok(`运行中 (pid ${side.pid})`) : badge.warn("未运行"),
      14,
      width,
    ),
  );
  lines.push(
    kv("  HTTP", side.httpOpen ? badge.ok(`127.0.0.1:${side.httpPort}`) : badge.dim("未监听"), 14, width),
  );
  lines.push(
    kv("  SOCKS5", side.socksOpen ? badge.ok(`127.0.0.1:${side.socksPort}`) : badge.dim("未监听"), 14, width),
  );

  lines.push("");
  lines.push(panelTitle("内网概况", width));
  lines.push(
    kv(
      "内网域名",
      state.loading ? c.dim("扫描中…") : `${c.bold(String(state.internalDomains.length))} 个解析到私网地址`,
      14,
      width,
    ),
  );
  lines.push(kv("公网域名", state.loading ? c.dim("—") : `${state.publicCount} 个`, 14, width));
  lines.push(kv("仍为假 IP", state.loading ? c.dim("—") : `${state.fakeCount} 个`, 14, width));
  lines.push(kv("无法解析", state.loading ? c.dim("—") : `${state.unresolvedCount} 个`, 14, width));
  lines.push(
    kv(
      "归并后缀",
      state.loading
        ? c.dim("—")
        : state.suffixes.length
          ? state.suffixes.map((s) => c.cyan(s)).join(c.dim("、"))
          : c.dim("无"),
      14,
      width,
    ),
  );

  if (state.notes?.length) {
    lines.push("");
    lines.push(panelTitle("提示", width));
    for (const note of state.notes.slice(0, 3)) lines.push(`  ${badge.warn(note)}`);
  }
  return lines;
}

export function renderDomains(state, width) {
  const lines = [];
  lines.push(panelTitle("内网域名", width));
  if (state.loading) {
    lines.push(c.dim("  正在扫描并解析…"));
    return lines;
  }
  if (!state.internalDomains.length) {
    lines.push(c.dim("  未发现解析到私网地址的域名"));
    return lines;
  }

  const nameWidth = Math.min(46, Math.max(20, width - 34));
  const ipWidth = Math.min(20, Math.max(12, width - nameWidth - 12));
  lines.push(
    `  ${c.dim(padEnd("域名", nameWidth))}${c.dim(padEnd("解析地址", ipWidth))}${c.dim("判定")}`,
  );
  lines.push(`  ${c.dim(SYMBOLS.hline.repeat(Math.min(width - 2, nameWidth + ipWidth + 6)))}`);
  for (const d of state.internalDomains.slice(0, 60)) {
    lines.push(
      `  ${padEnd(c.white(truncate(d.name, nameWidth)), nameWidth)}` +
        `${padEnd(c.cyan(truncate(d.ips.join(", "), ipWidth)), ipWidth)}` +
        `${badge.ok("私网")}`,
    );
  }
  if (state.internalDomains.length > 60) {
    lines.push(c.dim(`  …… 还有 ${state.internalDomains.length - 60} 个`));
  }
  return lines;
}

export function renderProcesses(state, width) {
  const lines = [];
  lines.push(panelTitle("程序代理能力", width));
  lines.push(
    c.dim(`  ${truncate("检测运行中程序是否支持 HTTPS_PROXY 环境变量（Go 的 httpproxy 符号）", width - 4)}`),
  );
  lines.push("");
  if (!state.processes.length) {
    lines.push(c.dim("  未发现相关进程"));
    return lines;
  }

  const nameWidth = Math.min(52, Math.max(20, width - 20));
  lines.push(`  ${c.dim(padEnd("程序", nameWidth))}${c.dim("代理能力")}`);
  lines.push(`  ${c.dim(SYMBOLS.hline.repeat(Math.min(width - 2, nameWidth + 10)))}`);

  for (const p of state.processes.slice(0, 40)) {
    const mark =
      p.status === "supported"
        ? badge.ok("支持")
        : p.status === "unsupported"
          ? badge.warn("不支持")
          : badge.dim("未知");
    // 截断到 nameWidth-1 再补一个空格，保证「✔ 支持」不会贴住程序名。
    const fitted = truncate(p.comm, nameWidth - 1);
    lines.push(`  ${padEnd(c.white(fitted), nameWidth)}${mark}`);
  }
  return lines;
}

export function renderRoutes(state, width) {
  const lines = [];
  lines.push(panelTitle("分流规则", width));
  lines.push(c.dim("  netfix proxy 依据此表决定目标走直连还是走内核"));
  lines.push("");
  lines.push(`  ${c.bold("内网后缀")} ${c.dim("(直连，不经过代理)")}`);
  if (state.loading) {
    lines.push(c.dim("    扫描中…"));
  } else if (state.suffixes.length) {
    for (const s of state.suffixes) {
      lines.push(`    ${c.cyan("+." + s)}`);
    }
  } else {
    lines.push(c.dim("    无"));
  }

  lines.push("");
  lines.push(`  ${c.bold("其他域名")} ${c.dim("(转交内核 7897 端口)")}`);
  lines.push(c.dim("    *"));

  lines.push("");
  lines.push(panelTitle("提示", width));
  lines.push(c.dim("  内网域名不会进入代理，因此不会拿到假 IP 地址。"));
  return lines;
}

export function renderEvents(events, width) {
  const lines = [];
  lines.push(panelTitle("操作日志", width));
  if (!events.length) {
    lines.push(c.dim("  暂无操作记录"));
    return lines;
  }
  for (const e of events.slice(-40).reverse()) {
    const time = c.dim(e.time);
    const tag =
      e.kind === "ok"
        ? badge.ok("")
        : e.kind === "warn"
          ? badge.warn("")
          : e.kind === "bad"
            ? badge.bad("")
            : badge.info("");
    lines.push(`  ${time} ${tag} ${e.text}`);
  }
  return lines;
}

export function renderFooter(width, { active, dirty, hint }) {
  const items = PANELS.map(
    (p) =>
      p.id === active
        ? c.reverse(` ${p.key} ${p.name} `)
        : c.dim(` ${p.key} ${p.name} `),
  );
  const line = ` ${items.join(c.dim("│"))} `;
  const pad = width - displayWidth(line) - 4;
  const status = dirty ? c.yellow("● 有更新，按 r 刷新") : "";
  const help = hint ? c.dim(hint) : "";
  return [
    "",
    ` ${line}${c.dim(SYMBOLS.hline.repeat(Math.max(0, pad)))}`,
    ` ${help}${status ? `   ${status}` : ""}`,
  ];
}
