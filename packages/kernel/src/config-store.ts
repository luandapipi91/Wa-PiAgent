import { readdir, readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { PI_AGENTS_DIR, ALL_AGENT_NAMES } from "@hiagent/shared";
import type { AgentConfig, AgentName } from "@hiagent/shared";
import { parseAgentMd, stringifyAgentMd, validateAgentConfig, makeDefaultAgentConfig } from "./agent-md";

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

  /** 名称清洗为可用文件名；冲突时追加 -2/-3 后缀 */
  private async uniqueName(base: string): Promise<string> {
    const existing = new Set((await this.listAgents()).map(a => a.name));
    if (!existing.has(base)) return base;
    for (let i = 2; ; i++) {
      const candidate = `${base}-${i}`;
      if (!existing.has(candidate)) return candidate;
    }
  }

  async createAgent(displayName: string): Promise<AgentConfig> {
    const trimmed = displayName.trim();
    if (!trimmed || /[/\\:*?"<>|]/.test(trimmed)) throw new Error(`非法 name: ${displayName}`);
    const name = await this.uniqueName(trimmed);
    const config = makeDefaultAgentConfig(name);
    await this.saveAgent(config);
    return config;
  }

  async deleteAgent(name: string): Promise<void> {
    if (!(await this.getAgent(name))) throw new Error(`智能体不存在: ${name}`);
    await unlink(join(this.agentsDir, `${name}.md`));
  }

  /** 重命名：删旧文件写新文件；返回校验错误（空数组 = 成功） */
  async renameAgent(oldName: string, config: AgentConfig): Promise<string[]> {
    const errs = validateAgentConfig(config);
    if (errs.length > 0) return errs;
    if (config.name !== oldName && await this.getAgent(config.name)) {
      return [`名称已被占用: ${config.name}`];
    }
    if (config.name !== oldName) await unlink(join(this.agentsDir, `${oldName}.md`));
    await this.saveAgent(config);
    return [];
  }

  /** 目录为空时 seed 4 个内置默认 agent（幂等） */
  async seedDefaults(): Promise<void> {
    if ((await this.listAgents()).length > 0) return;
    for (const name of ALL_AGENT_NAMES) await this.saveAgent(makeDefaultAgentConfig(name));
  }
}
