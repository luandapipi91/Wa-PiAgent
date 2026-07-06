import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { PI_AGENTS_DIR } from "@hiagent/shared";
import type { AgentConfig, AgentName } from "@hiagent/shared";
import { parseAgentMd, stringifyAgentMd, validateAgentConfig } from "./agent-md";

export class ConfigStore {
  constructor(private agentsDir: string = PI_AGENTS_DIR) {}

  async listAgents(): Promise<AgentConfig[]> {
    try {
      const files = await readdir(this.agentsDir);
      const mds = files.filter(f => f.endsWith(".md"));
      const configs: AgentConfig[] = [];
      for (const f of mds) {
        const content = await readFile(join(this.agentsDir, f), "utf8");
        try { configs.push(parseAgentMd(content)); } catch { /* 跳过损坏文件 */ }
      }
      return configs;
    } catch {
      return [];  // 目录不存在视为空
    }
  }

  async getAgent(name: AgentName): Promise<AgentConfig | null> {
    try {
      const content = await readFile(join(this.agentsDir, `${name}.md`), "utf8");
      return parseAgentMd(content);
    } catch {
      return null;
    }
  }

  async saveAgent(config: AgentConfig): Promise<string[]> {
    const errs = validateAgentConfig(config);
    if (errs.length > 0) return errs;
    await mkdir(this.agentsDir, { recursive: true });
    await writeFile(join(this.agentsDir, `${config.name}.md`), stringifyAgentMd(config), "utf8");
    return [];
  }
}
