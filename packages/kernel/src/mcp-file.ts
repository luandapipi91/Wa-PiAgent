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
    // 显式 undefined 视为「表单未填」，不得覆盖旧值：否则 toolExposure / enabled / timeout
    // 会被写成 undefined、被 JSON.stringify 丢弃 —— 写盘成功（ok: true）却把字段静默丢掉（F15 的同类伤害）。
    // 清空某字段应走 delete 语义，而不是靠 undefined。
    const patch = Object.fromEntries(
      Object.entries(rest).filter(([, v]) => v !== undefined),
    );
    // 关键：以旧条目为基底合并，未知字段得以保留
    cfg.mcpServers[name] = { ...previous, ...patch } as RawServer;
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
      const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
      // 形状守卫：不是对象（字面 null / 数组 / 字符串…）一律按解析失败报错，
      // 不能泄漏原生 TypeError（那会绕过 KernelError 错误码契约）。
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new KernelError(
          "mcp.configParseFailed",
          undefined,
          `根不是对象: ${path}`,
        );
      }
      const raw = (parsed as RawFile).mcpServers;
      // 值域不是 map（如 "abc" / 0）视为配置损坏：报错而非静默清空，
      // 否则 list() 会谎报「没有服务器」，save() 更会把新服务器写丢。
      if (raw !== undefined && raw !== null && typeof raw !== "object") {
        throw new KernelError(
          "mcp.configParseFailed",
          undefined,
          `mcpServers 不是对象: ${path}`,
        );
      }
      // 数组是「手工清空列表」的自然写法：无法表达具名服务器，视为空 map。
      const mcpServers =
        raw && !Array.isArray(raw) ? (raw as Record<string, RawServer>) : {};
      return { ...(parsed as RawFile), mcpServers };
    } catch (e: unknown) {
      if ((e as { code?: string }).code === "ENOENT") return { mcpServers: {} };
      if (e instanceof KernelError) throw e;
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
