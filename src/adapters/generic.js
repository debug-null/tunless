import fs from "node:fs";
import path from "node:path";
import { parseYaml, dumpYaml, extractTopLevelBlock, replaceTopLevelBlock } from "../core/yaml.js";

export class GenericAdapter {
  constructor(frontend) {
    this.frontend = frontend;
    this.id = "generic-mihomo";
    this.label = frontend?.label ?? "Generic mihomo";
  }

  get targetFile() {
    return this.frontend?.configFile ?? null;
  }

  async prepare() {
    if (!this.targetFile) {
      throw new Error(
        "未找到 mihomo 配置（已查找 ~/.config/mihomo/config.yaml 与 ~/.config/clash/config.yaml）；请用 --config <路径> 指定",
      );
    }
    return { file: this.targetFile };
  }

  readCurrentDns() {
    const text = fs.readFileSync(this.targetFile, "utf8");
    const parsed = parseYaml(text);
    return parsed.dns && typeof parsed.dns === "object" ? parsed.dns : {};
  }

  renderDnsBlock(dns) {
    return dumpYaml({ dns }, 0);
  }

  async apply(dnsSection) {
    const text = fs.readFileSync(this.targetFile, "utf8");
    const block = this.renderDnsBlock(dnsSection);
    const updated = replaceTopLevelBlock(text, "dns", block);
    fs.writeFileSync(this.targetFile, updated, "utf8");
    return { file: this.targetFile, needsRestart: false };
  }

  async reload(api) {
    await api.reloadConfig(this.targetFile);
  }
}
