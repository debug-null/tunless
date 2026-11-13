// 内网域名与规则屏：扫到的域名、生效中/待生效的后缀、手写规则列表。
// 域名部分从向导第 5 步（StepDomains）平移，语义一致、架子换成钻取屏；
// 手写规则在这里多走一步：列出具体内容并能上下选中删掉。
import { Box, Text } from "ink";
import { h, useTheme, useUnicode, Section } from "../ui.js";
import { symbolSet } from "../theme.js";
import { padEnd } from "../width.js";
import { rowsFor } from "../../core/status-rows.js";
import { StatusRow } from "../components/status-row.js";

// 一屏放多少条手写规则。条数更多时窗口跟着 ruleIndex 走，
// 保证光标永远落在看得见的行上 —— 只切前 8 条的话，按下键
// 走过 8 光标就凭空消失，看着像按键失灵。
const MAX_RULE_ROWS = 8;

export function DomainsScreen({ state, width = 80, ruleIndex = 0, rules = [] }) {
  const theme = useTheme();
  const symbols = symbolSet(useUnicode());
  const internalRow = rowsFor(state).find((r) => r.id === "internal");
  const domains = state.internalDomains ?? [];

  const domainLines = [];
  if (!domains.length) {
    if (state?.loading) {
      domainLines.push(h(Text, { key: "loading", dimColor: true }, "  正在探测…"));
    } else if (state.dnsAlive === false) {
      domainLines.push(
        h(
          Text,
          { key: "dns-dead" },
          h(
            Text,
            { color: theme.colors.warn },
            `  内网 DNS ${state.internalDns ?? ""} 不可达，本次没扫`,
          ),
        ),
      );
      domainLines.push(
        h(
          Text,
          { key: "dns-note", dimColor: true },
          "  不在公司网络时这是正常的；也可以按 a 手写一条",
        ),
      );
    } else {
      domainLines.push(h(Text, { key: "empty", dimColor: true }, "  没扫到内网域名"));
      domainLines.push(
        h(
          Text,
          { key: "empty-note", dimColor: true },
          "  多半是没给终端完全磁盘访问权限，也可以按 a 手写一条",
        ),
      );
    }
  } else {
    const nameWidth = Math.max(...domains.map((d) => d.name.length)) + 2;
    domains.slice(0, 10).forEach((domain, i) => {
      domainLines.push(
        h(
          Text,
          { key: `d-${i}` },
          h(Text, { color: theme.colors.ok }, `  ${symbols.ok} `),
          padEnd(domain.name, nameWidth),
          h(Text, { dimColor: true }, domain.ips?.[0] ?? ""),
        ),
      );
    });
    if (domains.length > 10) {
      domainLines.push(
        h(Text, { key: "more", dimColor: true }, `  …… 还有 ${domains.length - 10} 个`),
      );
    }
    domainLines.push(h(Text, { key: "gap" }, " "));

    // 分清「正在生效的」和「重启后才生效的」。运行中的服务加载的是它
    // 启动那一刻算好的后缀集，刚扫出来的域名不会自己进去。
    const active = state.sidecar?.activeSuffixes ?? [];
    const pending = state.sidecar?.pendingSuffixes ?? [];
    if (state.sidecar?.running) {
      domainLines.push(
        h(
          Text,
          { key: "active" },
          h(Text, { color: theme.colors.ok }, `  转发服务正在分流 ${active.length} 个后缀`),
        ),
      );
      if (pending.length) {
        domainLines.push(
          h(
            Text,
            { key: "pending" },
            h(
              Text,
              { color: theme.colors.warn },
              `  还有 ${pending.length} 个后缀要重启服务才生效（按 s 重启）`,
            ),
          ),
        );
      }
    } else {
      domainLines.push(
        h(
          Text,
          { key: "off", dimColor: true },
          "  转发服务没在跑，启动后这些域名会走直连",
        ),
      );
    }
  }

  // 手写规则区：窗口跟光标走，上/下两端各留「还有」提示。
  const cursor = Math.min(Math.max(0, ruleIndex), Math.max(0, rules.length - 1));
  const start = Math.max(
    0,
    Math.min(cursor - (MAX_RULE_ROWS - 1), Math.max(0, rules.length - MAX_RULE_ROWS)),
  );
  const view = rules.slice(start, start + MAX_RULE_ROWS);
  const below = rules.length - start - view.length;

  const ruleLines = [];
  if (!rules.length) {
    ruleLines.push(
      h(Text, { key: "none", dimColor: true }, "  还没有手动规则 · 按 a 加一条"),
    );
  } else {
    if (start > 0) {
      ruleLines.push(
        h(Text, { key: "above", dimColor: true }, `  …… 前面还有 ${start} 条`),
      );
    }
    view.forEach((rule, i) => {
      const selected = start + i === cursor;
      ruleLines.push(
        h(
          Text,
          { key: `r-${start + i}` },
          h(
            Text,
            { color: selected ? theme.colors.accent : undefined, bold: selected },
            selected ? `  ${symbols.arrow} ` : "    ",
          ),
          h(Text, { dimColor: !selected }, padEnd(rule.kind, 9)),
          h(
            Text,
            { color: selected ? theme.colors.accent : undefined, bold: selected },
            rule.value,
          ),
        ),
      );
    });
    if (below > 0) {
      ruleLines.push(
        h(Text, { key: "below", dimColor: true }, `  …… 还有 ${below} 条`),
      );
    }
  }
  ruleLines.push(
    h(
      Text,
      { key: "note", dimColor: true },
      "  手写规则会并进内网分流，改完自动重启服务",
    ),
  );

  return h(
    Box,
    { flexDirection: "column" },
    h(Text, { color: theme.colors.accent, bold: true }, " 内网域名与规则"),
    h(Text, null, " "),
    h(StatusRow, { row: internalRow, selected: false, width }),
    h(Section, { title: "内网域名" }, ...domainLines),
    h(Section, { title: "手写规则" }, ...ruleLines),
  );
}
