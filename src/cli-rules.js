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
} from "./core/rules.js";

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
    say("\n  这些规则会让匹配的域名直连（不经过代理），转发服务重启后生效：");
    say(dim("    tunless service uninstall && tunless service install"));
    say("  加一条：");
    say(dim("    tunless rules add matrix.17usoft.com"));
    say(dim("    tunless rules add jira --keyword"));
    say(dim("    tunless rules add 10.0.0.0/8"));
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
    say(`  ${dim("重启转发服务后生效：tunless service uninstall && tunless service install")}\n`);
    return 0;
  }

  say(HEAD);
  say(`  未知操作：${action}`);
  say(dim("  可用：list | add <值> | remove <值>"));
  say(dim("  加关键词用 --keyword，加网段直接写 10.0.0.0/8 即可自动识别"));
  return 1;
}
