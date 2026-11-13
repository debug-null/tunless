// `tunless rules` — 手动维护内网分流规则。
//
// 自动扫描依赖「本机历史 + 解析到私网地址」，覆盖不到所有情况，
// 也不能要求用户去开「完全磁盘访问权限」才算能用。
// 这里给一条不依赖任何授权的路：用户自己写域名、关键词或 IP 段。

import {
  loadRules,
  saveRules,
  addRule,
  removeRule,
  totalRules,
  rulesFile,
  RULE_KINDS,
  loadLearnedSuffixes,
  clearLearnedSuffixes,
} from "./core/rules.js";
import { serviceStatus, restartService } from "./core/launchd.js";

const HEAD = "\n── tunless 内网规则 ──\n";

const KIND_LABEL = {
  domain: "域名后缀",
  keyword: "关键词",
  cidr: "IP 段",
};

export function renderRules(rules) {
  const lines = [];
  for (const kind of RULE_KINDS) {
    const list = rules[kind] ?? [];
    lines.push(`  ${KIND_LABEL[kind]}（${list.length}）`);
    if (!list.length) {
      lines.push("    无");
      continue;
    }
    for (const value of list) lines.push(`    ${value}`);
  }
  return lines.join("\n");
}

export async function cmdRules(args, ctx = {}) {
  const { say = console.log, ok = (s) => s, warn = (s) => s, info = (s) => s, dim = (s) => s } = ctx;
  const action = args._[1] || args.flags.action || "list";
  const values = args._.slice(2);
  const kindHint = args.flags.keyword ? "keyword" : args.flags.cidr ? "cidr" : undefined;

  if (action === "list" || action === "ls") {
    const rules = loadRules();
    say(HEAD);
    say(`  规则文件：${dim(rulesFile())}`);
    say(`  共 ${totalRules(rules)} 条\n`);
    say(renderRules(rules));
    const learned = loadLearnedSuffixes();
    if (learned.length) {
      say(`\n  扫描学到的内网后缀（${learned.length}，随扫描自动累积）：`);
      for (const s of learned) say(`    ${s}`);
      say(dim("    想清空重来：tunless rules reset-learned"));
    }
    say("\n  这些规则会让匹配的域名直连（不经过代理），转发服务重启后生效：");
    say(dim("    tunless service restart"));
    say("  加一条：");
    say(dim("    tunless rules add matrix.17usoft.com"));
    say(dim("    tunless rules add jira --keyword"));
    say(dim("    tunless rules add 10.0.0.0/8"));
    return 0;
  }

  // 学到的后缀是「只增不减」的 —— 换网络后旧后缀可能已经不再属于内网，
  // 留一条让用户清空重扫的路，不然错误后缀会一直把域名导去直连。
  if (action === "reset-learned") {
    const learned = loadLearnedSuffixes();
    clearLearnedSuffixes();
    say(`\n  ${ok(`已清空 ${learned.length} 条扫描学到的后缀`)}`);
    say(dim("    下次运行 tunless proxy / fix 时会重新扫描\n"));
    const svc = await serviceStatus();
    if (svc.running) {
      say(dim("    正在重启转发服务…"));
      const st = await restartService();
      say(
        st.running
          ? `  ${ok("转发服务已重启")}\n`
          : `  ${warn("转发服务没有起来，tunless service logs 看原因")}\n`,
      );
    }
    return 0;
  }

  if (action === "add" || action === "rm" || action === "remove" || action === "del") {
    if (!values.length) {
      say(`  ${warn("要加什么？例如：tunless rules add 17usoft.com")}`);
      return 1;
    }
    let rules = loadRules();
    const isRemove = action !== "add";
    for (const value of values) {
      const result = isRemove
        ? removeRule(rules, value, kindHint)
        : addRule(rules, value, kindHint);
      rules = result.rules;
      const label = KIND_LABEL[result.rule.kind];
      if (isRemove) {
        say(
          result.removed
            ? `  ${ok(`已删除${label}：${result.rule.value}`)}`
            : `  ${warn(`没有这条规则：${value}`)}`,
        );
      } else {
        say(
          result.added
            ? `  ${ok(`已添加${label}：${result.rule.value}`)}`
            : `  ${info(`已存在：${result.rule.value}`)}`,
        );
      }
    }
    saveRules(rules);
    say(`\n  ${info(`规则文件：${rulesFile()}`)}`);
    // 服务在跑就直接重启让规则生效 —— 之前让用户自己 uninstall &&
    // install，不但麻烦，uninstall 还会顺手清掉登录会话变量。
    const svc = await serviceStatus();
    if (svc.running) {
      say(dim("    正在重启转发服务让规则生效…"));
      const st = await restartService();
      say(
        st.running
          ? `  ${ok("转发服务已重启，规则已生效")}\n`
          : `  ${warn("转发服务没有起来，tunless service logs 看原因")}\n`,
      );
    } else {
      say(dim("    转发服务没在运行，下次启动就会用上\n"));
    }
    return 0;
  }

  say(HEAD);
  say(`  未知操作：${action}`);
  say(dim("  可用：list | add <值> | remove <值> | reset-learned"));
  say(dim("  加关键词用 --keyword，加网段直接写 10.0.0.0/8 即可自动识别"));
  return 1;
}
