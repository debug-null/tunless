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
        "no mihomo config found (looked for ~/.config/mihomo/config.yaml and ~/.config/clash/config.yaml); pass --config <path>",
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
