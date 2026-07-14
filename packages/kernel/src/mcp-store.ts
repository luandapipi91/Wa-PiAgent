import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { McpServerConfig, McpToolSummary } from "@hiagent/shared";
import type { ProjectStore } from "./project-store";

interface McpConfigFile {
  mcpServers: Record<string, Omit<McpServerConfig, "name">>;
  settings?: Record<string, unknown>;
}

export interface McpStoreOpts {
  hiagentDir: string;
  projectStore: ProjectStore;
}

export class McpStore {
  constructor(private opts: McpStoreOpts) {}

  async list(projectId?: string): Promise<McpServerConfig[]> {
    const path = await this.resolveConfigPath(projectId);
    const cfg = await this.readConfig(path);
    return Object.entries(cfg.mcpServers).map(([name, server]) => ({
      name,
      ...server,
    }));
  }

  async save(config: McpServerConfig, projectId?: string, originalName?: string): Promise<void> {
    const path = await this.resolveConfigPath(projectId);
    const cfg = await this.readConfig(path);
    const { name, ...serverData } = config;

    if (originalName) {
      if (!cfg.mcpServers[originalName]) {
        throw new Error(`原服务器 ${originalName} 不存在`);
      }
      if (originalName !== config.name) {
        delete cfg.mcpServers[originalName];
      }
    }

    cfg.mcpServers[name] = serverData;
    await this.writeConfig(path, cfg);
  }

  async delete(serverName: string, projectId?: string): Promise<void> {
    const path = await this.resolveConfigPath(projectId);
    const cfg = await this.readConfig(path);
    if (!cfg.mcpServers[serverName]) {
      throw new Error(`服务器 ${serverName} 不存在`);
    }
    delete cfg.mcpServers[serverName];
    await this.writeConfig(path, cfg);
  }

  async listTools(serverName: string): Promise<McpToolSummary[]> {
    const cachePath = join(this.opts.hiagentDir, "mcp-cache.json");
    try {
      const raw = await readFile(cachePath, "utf8");
      const cache = JSON.parse(raw);
      const serverCache = cache[serverName];
      if (!serverCache || !Array.isArray(serverCache.tools)) {
        return [];
      }
      return serverCache.tools.map((t: Record<string, unknown>) => ({
        name: t.name ?? "",
        description: t.description,
        parameters: t.inputSchema?.properties
          ? Object.entries(t.inputSchema.properties).map(([pname, pschema]: [string, Record<string, unknown>]) => ({
              name: pname,
              type: pschema.type ?? "string",
              description: pschema.description as string | undefined,
            }))
          : undefined,
      }));
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== "ENOENT") {
        console.warn("[mcp-store] 读取 MCP 缓存失败:", err.message ?? err);
      }
      return [];
    }
  }

  // ===== 内部方法 =====

  private async resolveConfigPath(projectId?: string): Promise<string> {
    if (!projectId) {
      return join(this.opts.hiagentDir, "mcp.json");
    }
    const { projects } = await this.opts.projectStore.load();
    const project = projects.find(p => p.id === projectId);
    if (!project || !project.cwd) {
      throw new Error(`项目不存在或缺少工作目录: ${projectId}`);
    }
    return join(project.cwd, ".mcp.json");
  }

  private async readConfig(path: string): Promise<McpConfigFile> {
    try {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw);
      return {
        mcpServers: parsed.mcpServers ?? {},
        settings: parsed.settings,
      };
    } catch (e: any) {
      if (e.code === "ENOENT") {
        return { mcpServers: {} };
      }
      throw new Error(`解析 ${path} 失败: ${e.message}`);
    }
  }

  private async writeConfig(path: string, data: McpConfigFile): Promise<void> {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
    }
    await writeFile(path, JSON.stringify(data, null, 2), "utf8");
  }
}
