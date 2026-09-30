// McpFile：MCP 配置文件的**唯一写入者**。
//
// 盘上两种作用域：
//   - 全局：<WA_PI_DIR>/mcp.json
//   - 项目：<project.cwd>/.pi/mcp.json（由 projectPathFor 回调解析，规格 F11）
//
// 两条铁律：
//   1. 保留未知字段 —— server 条目以**旧条目为基底**合并，其他工具/用户写的键不得被抹掉
//      （旧实现整条替换条目，历史 bug F15）。
//   2. 校验失败不写盘 —— validateMcpServer 报错则直接返回，文件保持原样。
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  type McpFieldError,
  type McpServerConfig,
  validateMcpServer,
} from "@wa-pi/shared";
import { KernelError } from "./kernel-error.ts";

/** 盘上文件形状：server 条目保留任意未知字段 */
type RawServer = Record<string, unknown> & { name?: string };
interface RawFile {
  mcpServers: Record<string, RawServer>;
  autoEnableCodemode?: boolean;
  [key: string]: unknown;
}

export interface McpFileOpts {
  /** <WA_PI_DIR>/mcp.json */
  globalPath: string;
  /** 由 projectId 解析出 <project.cwd>/.pi/mcp.json */
  projectPathFor: (projectId: string) => Promise<string>;
}

export class McpFile {
  constructor(private opts: McpFileOpts) {}

  async list(projectId?: string): Promise<McpServerConfig[]> {
    const path = await this.resolvePath(projectId);
    const cfg = await this.read(path);
    return Object.entries(cfg.mcpServers).map(
      ([name, v]) => ({ name, ...v }) as McpServerConfig,
    );
  }

  async getAutoEnableCodemode(projectId?: string): Promise<boolean> {
    const cfg = await this.read(await this.resolvePath(projectId));
    return cfg.autoEnableCodemode !== false;
  }

  /** 保存（新增或替换）。unknown 字段原样保留；校验失败不写盘。 */
  async save(
    input: McpServerConfig,
    projectId?: string,
    originalName?: string,
  ): Promise<{ ok: true } | { ok: false; errors: McpFieldError[] }> {
    const errors = validateMcpServer(input);
    if (errors.length > 0) return { ok: false, errors };

    const path = await this.resolvePath(projectId);
    const cfg = await this.read(path);
    const { name, ...rest } = input;
    const previous =
      cfg.mcpServers[name] ??
      (originalName ? cfg.mcpServers[originalName] : undefined) ??
      {};
    // 关键：以旧条目为基底合并，未知字段得以保留
    cfg.mcpServers[name] = { ...previous, ...rest, name: undefined } as RawServer;
    delete (cfg.mcpServers[name] as { name?: unknown }).name;
    if (originalName && originalName !== name) delete cfg.mcpServers[originalName];
    await this.write(path, cfg);
    return { ok: true };
  }

  async delete(serverName: string, projectId?: string): Promise<void> {
    const path = await this.resolvePath(projectId);
    const cfg = await this.read(path);
    if (!cfg.mcpServers[serverName]) {
      throw new KernelError("mcp.serverNotFound", { name: serverName });
    }
    delete cfg.mcpServers[serverName];
    await this.write(path, cfg);
  }

  /** 供测试与迁移使用 */
  async readPath(path: string): Promise<RawFile> {
    return this.read(path);
  }

  private async resolvePath(projectId?: string): Promise<string> {
    return projectId ? await this.opts.projectPathFor(projectId) : this.opts.globalPath;
  }

  private async read(path: string): Promise<RawFile> {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as RawFile;
      return { ...parsed, mcpServers: parsed.mcpServers ?? {} };
    } catch (e: unknown) {
      if ((e as { code?: string }).code === "ENOENT") return { mcpServers: {} };
      throw new KernelError(
        "mcp.configParseFailed",
        undefined,
        `解析 ${path} 失败: ${String(e)}`,
      );
    }
  }

  /** 原子替换：先写临时文件再 rename，避免半写 */
  private async write(path: string, cfg: RawFile): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(cfg, null, 2), "utf8");
    await rename(tmp, path);
  }
}

/** 项目 id → <cwd>/.pi/mcp.json（规格 F11） */
export function projectMcpPath(projectCwd: string): string {
  return join(projectCwd, ".pi", "mcp.json");
}

export function hasProjectMcpFile(projectCwd: string): boolean {
  return existsSync(projectMcpPath(projectCwd));
}
