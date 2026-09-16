// memory-store.ts — 记忆与指令文件管理服务（UI 侧）
//
// 设计要点：
// - 记忆读写全部委托 memory/*（SQLite DAO）：单库 <waPiDir>/memories.db 统管 global + project。
//   旧的 markdown（amaster § 分隔文件）与归档 sidecar JSON 已由一次性迁移导入 DB，
//   本服务不再触碰这两类文件。
// - entry id 即 DAO 的 uuid（不透明字符串）；update/archive/restore/purge 直接按 id 走 DAO。
// - projectId 是 UI 侧项目 id，查库前经 ProjectStore → cwd → projectNameFromCwd 解析为项目名
//   （DB 的 project_id 列存的是项目名，与历史 projects-memory/<basename> 约定一致）。
// - 指令文件仅扫描 AGENTS.md / CLAUDE.md（全局 + 项目 cwd）；记忆配置开关读写
//   hermes-memory-config.json。两者与记忆存储无关，逻辑原样保留。

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import type {
  MemoryEntry,
  ArchivedMemory,
  InstructionFile,
  MemoryConfig,
  MemoryKind,
  MemoryScope,
  MemorySearchResult,
} from "@wa-pi/shared";
import { KernelError } from "./kernel-error";
import type { ProjectStore } from "./project-store";
import { openMemoryDb } from "./memory/db";
import { MemoryDao, type ListOpts, type MemoryRow } from "./memory/dao";
import { projectNameFromCwd } from "./memory/paths";

const HERMES_CONFIG_FILE = "hermes-memory-config.json";

export interface MemoryStoreOpts {
  waPiDir: string;
  projectStore: ProjectStore;
}

/** 检索入参（UI「搜索记忆」）：scope/kind 空串视为未指定 */
export interface MemorySearchOpts {
  query: string;
  scope?: MemoryScope | "";
  kind?: MemoryKind | "";
  /** UI 侧项目 id；作为过滤条件时必须是可解析的项目 */
  projectId?: string;
  limit?: number;
  includeArchived?: boolean;
}

export class MemoryStore {
  constructor(private opts: MemoryStoreOpts) {}

  /** 记忆库连接（openMemoryDb 按路径缓存，重复调用无额外开销） */
  private dao(): MemoryDao {
    return new MemoryDao(openMemoryDb(this.opts.waPiDir));
  }

  /** MemoryRow → shared 的 MemoryEntry（sourceFile/rawIndex 已废弃，不再填充） */
  private toEntry(r: MemoryRow): MemoryEntry {
    return {
      id: r.id,
      text: r.content,
      category: r.target === "user" ? "user" : "memory",
      scope: r.scope,
      kind: r.kind,
      createdAt: new Date(r.createdAt).toISOString(),
      updatedAt: new Date(r.updatedAt).toISOString(),
      projectId: r.projectId ?? undefined,
    };
  }

  /**
   * 列出所有记忆 + 归档记忆
   * @param projectId 当前项目 ID；传入时额外读取对应项目记忆，不传则只返回全局记忆
   */
  async list(
    projectId?: string,
  ): Promise<{ memories: MemoryEntry[]; archived: ArchivedMemory[] }> {
    const dao = this.dao();
    const projectName = projectId ? await this.getProjectName(projectId) : null;

    const globals = dao.list({ scope: "global", includeArchived: false });
    const projects = projectName
      ? dao.list({ scope: "project", projectId: projectName, includeArchived: false })
      : [];
    // 归档段与旧 sidecar 等价：不按作用域/项目切分，一条全局归档列表
    const archived = dao
      .list({ includeArchived: true })
      .filter((r) => r.archived === 1);

    return {
      memories: [...globals, ...projects].map((r) => this.toEntry(r)),
      archived: archived.map((r) => ({
        ...this.toEntry(r),
        archivedAt: new Date(r.archivedAt ?? 0).toISOString(),
      })),
    };
  }

  /**
   * 全文检索：BM25 + 时间衰减 + kind 加权综合排序（spec §5）。
   *
   * scope 语义（与工具层 memory_search / spec §5 对齐）：
   * - "global"：只搜全局条目（全局条目的 project_id 为 NULL，无需按项目过滤）
   * - "project"：限定到 projectId 对应项目；projectId 缺失或不可解析即 project.notFound，
   *   绝不降级为「不加项目过滤」，否则等于跨项目读到别的项目的记忆
   * - 未指定：**跨域检索 = 全局 + 所有项目**（等价于「全部」），不按项目过滤
   *
   * projectId 只要显式给出就必须可解析：解析不到即 project.notFound。
   * 绝不能静默忽略调用方给出的过滤条件（静默忽略会返回全部项目的结果）。
   *
   * totalMatched 与 results 共用同一份过滤条件（dao 层 matchClause 复用），
   * 且是未截断的真实命中总数——不受 limit、也不受检索候选上限影响。
   */
  async search(opts: MemorySearchOpts): Promise<{
    results: MemorySearchResult[];
    totalMatched: number;
  }> {
    const scope = opts.scope || undefined;
    const projectId = opts.projectId?.trim() || undefined;

    // projectId → 项目名（DB 的 project_id 列存的是项目名，不是 UI 的 project id）
    const projectName = projectId ? await this.getProjectName(projectId) : null;
    if (projectId && !projectName) {
      throw new KernelError("project.notFound", { id: projectId });
    }
    if (scope === "project" && !projectName) {
      throw new KernelError("project.notFound", { id: projectId ?? "" });
    }

    // 只有显式 scope=project 才把项目当成过滤条件；未指定 scope 是跨域检索
    const filter: ListOpts = {
      scope,
      projectId: scope === "project" ? projectName : null,
      kind: opts.kind || undefined,
      includeArchived: opts.includeArchived === true,
    };

    const dao = this.dao();
    const results = dao.search(opts.query, { ...filter, limit: opts.limit }).map((h) => ({
      id: h.id,
      title: h.title,
      snippet: h.snippet,
      kind: h.kind,
      scope: h.scope,
      projectId: h.projectId ?? undefined,
      updatedAt: new Date(h.updatedAt).toISOString(),
      score: Number(h.score.toFixed(4)),
      archived: h.archived === 1,
    }));

    return { results, totalMatched: dao.countMatches(opts.query, filter) };
  }

  /**
   * 手动添加记忆（UI「+ 添加」入口）。
   * 固定写入 memory target（USER target 由 agent 维护）。
   */
  async add(scope: MemoryScope, text: string, projectId?: string): Promise<void> {
    let projectName: string | null = null;
    if (scope === "project") {
      if (!projectId) throw new Error("项目记忆需要 projectId");
      projectName = await this.getProjectName(projectId);
      if (!projectName) throw new KernelError("project.notFound", { id: projectId });
    }
    this.dao().insert({
      kind: "knowledge",
      target: "memory",
      scope,
      projectId: projectName,
      content: text,
      source: "ui",
    });
  }

  /** 编辑记忆 */
  async update(id: string, text: string): Promise<void> {
    if (!this.dao().updateContent(id, text)) throw new KernelError("memory.entryStale");
  }

  /** 归档（软删除） */
  async archive(id: string): Promise<void> {
    if (!this.dao().archive(id)) throw new KernelError("memory.entryStale");
  }

  /** 恢复归档条目 */
  async restore(id: string): Promise<void> {
    if (!this.dao().restore(id)) throw new KernelError("memory.archiveNotFound", { id });
  }

  /** 彻底删除归档条目 */
  async purge(id: string): Promise<void> {
    if (!this.dao().remove(id)) throw new KernelError("memory.archiveNotFound", { id });
  }

  /** 扫描已加载的指令文件，对齐 pi 框架 resource-loader.js loadProjectContextFiles 行为：
   *  - 候选文件名：AGENTS.md, AGENTS.MD, CLAUDE.md, CLAUDE.MD（取第一个命中）
   *  - 扫描范围：agentDir (waPiDir) + cwd + 所有祖先目录（向上走到根）
   *  - 去重：同一文件路径不重复出现 */
  async listInstructions(projectId: string): Promise<InstructionFile[]> {
    const result: InstructionFile[] = [];
    const seen = new Set<string>();
    // pi 的 candidates 顺序：AGENTS.md > AGENTS.MD > CLAUDE.md > CLAUDE.MD
    const candidates = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];

    /** 从指定目录加载第一个命中的指令文件（null = 无命中/已见过）。
     *  用磁盘上实际文件名（readdir）做路径去重，兼容 macOS 大小写不敏感文件系统。 */
    const loadFromDir = async (
      dir: string,
    ): Promise<InstructionFile | null> => {
      try {
        const dirents = await readdir(dir);
        for (const candidate of candidates) {
          // 在目录 entries 中查找匹配（直接按名匹配，兼顾大小写不敏感系统）
          const match = dirents.find((d) => d === candidate);
          if (match) {
            const p = join(dir, match);
            if (seen.has(p)) continue;
            try {
              const content = await readFile(p, "utf8");
              seen.add(p);
              return { path: p, name: match, scope: "global", content };
            } catch {
              // 不可读则跳过
            }
          }
        }
      } catch {
        // readdir 失败（如目录不存在/无权限）→ 静默跳过
      }
      return null;
    };

    // 1. agentDir（全局，对应 pi 的 resolvedAgentDir）
    const globalFile = await loadFromDir(this.opts.waPiDir);
    if (globalFile) {
      globalFile.scope = "global";
      result.push(globalFile);
    }

    // 2. cwd + 祖先目录遍历（项目级，对齐 pi 从 cwd 向上到根的遍历逻辑）
    const cwd = await this.getProjectCwd(projectId);
    if (cwd) {
      const ancestors: InstructionFile[] = [];
      let currentDir = cwd;
      while (true) {
        const file = await loadFromDir(currentDir);
        if (file) {
          file.scope = "project";
          // pi 用 unshift 保证祖先顺序（根在前），这里同样前置
          ancestors.unshift(file);
        }
        const parentDir = dirname(currentDir);
        if (parentDir === currentDir) break;
        currentDir = parentDir;
      }
      result.push(...ancestors);
    }

    return result;
  }

  /** 读记忆配置开关 */
  async getConfig(): Promise<MemoryConfig> {
    try {
      const raw = await readFile(
        join(this.opts.waPiDir, HERMES_CONFIG_FILE),
        "utf8",
      );
      const data = JSON.parse(raw);
      return {
        reviewEnabled: data.reviewEnabled ?? true,
        memoryPolicyStyle: data.memoryPolicyStyle ?? "full",
      };
    } catch {
      return { reviewEnabled: true, memoryPolicyStyle: "full" };
    }
  }

  /** 写记忆配置开关（合并写入，不覆盖其他字段） */
  async setConfig(opts: {
    reviewEnabled?: boolean;
    memoryPolicyStyle?: "full" | "compact" | "none";
  }): Promise<void> {
    const configPath = join(this.opts.waPiDir, HERMES_CONFIG_FILE);
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(await readFile(configPath, "utf8"));
    } catch {
      // 文件不存在，从空开始
    }
    if (opts.reviewEnabled !== undefined)
      existing.reviewEnabled = opts.reviewEnabled;
    if (opts.memoryPolicyStyle !== undefined)
      existing.memoryPolicyStyle = opts.memoryPolicyStyle;
    await mkdir(this.opts.waPiDir, { recursive: true });
    await writeFile(configPath, JSON.stringify(existing, null, 2), "utf8");
  }

  // —— 辅助方法 ——

  /** 按 projectId 从 ProjectStore 查 cwd */
  private async getProjectCwd(projectId: string): Promise<string | null> {
    const { projects } = await this.opts.projectStore.load();
    return projects.find((p) => p.id === projectId)?.cwd ?? null;
  }

  /** projectId（UI id）→ 项目名（DB project_id 列 / 历史目录名）；查不到返回 null */
  private async getProjectName(projectId: string): Promise<string | null> {
    const cwd = await this.getProjectCwd(projectId);
    return cwd ? projectNameFromCwd(cwd) : null;
  }
}
