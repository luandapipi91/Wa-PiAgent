import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { McpServerConfig } from "@wa-pi/shared";
import { KernelError } from "./kernel-error";
import type { ProjectStore } from "./project-store";

interface McpConfigFile {
  mcpServers: Record<string, Omit<McpServerConfig, "name">>;
  settings?: Record<string, unknown>;
}

export interface McpStoreOpts {
  waPiDir: string;
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

  /** 取单个服务器配置（含 name）；不存在抛错。供连接测试 / 工具列举复用 */
  async getServer(
    serverName: string,
    projectId?: string,
  ): Promise<McpServerConfig> {
    const servers = await this.list(projectId);
    const server = servers.find((s) => s.name === serverName);
    if (!server) {
      throw new KernelError("mcp.serverNotFound", { name: serverName });
    }
    return server;
  }

  /** 读全局 mcp.json 的 settings 段（无则 {}）— pi-mcp-adapter 的 directTools / toolPrefix 配置 */
  async getGlobalSettings(): Promise<Record<string, unknown>> {
    const cfg = await this.readConfig(join(this.opts.waPiDir, "mcp.json"));
    return cfg.settings ?? {};
  }

  async save(
    config: McpServerConfig,
    projectId?: string,
    originalName?: string,
  ): Promise<void> {
    const path = await this.resolveConfigPath(projectId);
    const cfg = await this.readConfig(path);
    const { name, ...serverData } = config;

    if (originalName) {
      if (!cfg.mcpServers[originalName]) {
        throw new KernelError("mcp.originalServerNotFound", {
          name: originalName,
        });
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
      throw new KernelError("mcp.serverNotFound", { name: serverName });
    }
    delete cfg.mcpServers[serverName];
    await this.writeConfig(path, cfg);
  }

  // ===== 内部方法 =====

  private async resolveConfigPath(projectId?: string): Promise<string> {
    if (!projectId) {
      return join(this.opts.waPiDir, "mcp.json");
    }
    const { projects } = await this.opts.projectStore.load();
    const project = projects.find((p) => p.id === projectId);
    if (!project) {
      throw new KernelError("project.notFound", { id: projectId });
    }
    if (!project.cwd) {
      throw new KernelError("project.cwdMissing", {
        name: project.name ?? projectId,
      });
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
      throw new KernelError(
        "mcp.configParseFailed",
        undefined,
        `解析 ${path} 失败: ${e.message}`,
      );
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
