import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentConfig } from "hiagent-shared";
import { parseAgentMd, serializeAgentMd } from "./agent-md";

export class ConfigStore {
  constructor(private agentsDir: string) {}

  async listAgents(): Promise<AgentConfig[]> {
    try {
      const files = await readdir(this.agentsDir);
      const configs = await Promise.all(
        files.filter(f => f.endsWith(".md")).map(f => this.readAgentFile(join(this.agentsDir, f)))
      );
      return configs.filter((c): c is AgentConfig => c !== null);
    } catch (e: any) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  }

  async getAgent(name: string): Promise<AgentConfig | null> {
    return this.readAgentFile(join(this.agentsDir, `${name}.md`));
  }

  async saveAgent(config: AgentConfig): Promise<void> {
    await mkdir(this.agentsDir, { recursive: true });
    await writeFile(join(this.agentsDir, `${config.name}.md`), serializeAgentMd(config), "utf-8");
  }

  private async readAgentFile(path: string): Promise<AgentConfig | null> {
    try { return parseAgentMd(await readFile(path, "utf-8")); }
    catch (e: any) { if (e.code === "ENOENT") return null; throw e; }
  }
}
