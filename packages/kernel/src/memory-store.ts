// memory-store.ts — 记忆与指令文件管理服务
//
// 设计要点：
// - 记忆读写全部委托 amaster-memory（@amaster.ai/pi-memory host-controlled 包装层）：
//   全局 <hiagentDir>/memories/global，项目 <hiagentDir>/projects-memory/<basename>。
//   § 分隔格式由 amaster 单一维护，避免外部裸写触发 drift 检测。
// - 归档使用 sidecar JSON（~/.hiagent/memory-archive.json），hiagent 自管，不进 amaster 文件。
// - 记忆配置开关读写 hermes-memory-config.json。
// - 指令文件仅扫描 AGENTS.md / CLAUDE.md（全局 + 项目 cwd）；记忆内容已由 memory tab
//   展示、并由 AgentManager 注入系统提示词快照，不再作为指令文件重复注入。
// - entry id 编码 "<relPath>:<rawIndex>"，relPath 相对 hiagentDir，rawIndex 为该 store+target
//   下 entries 的下标；变更时按 id 反查 store 并取 entries[rawIndex] 作为 oldText 调 amaster。

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type {
  MemoryEntry, ArchivedMemory, InstructionFile, MemoryConfig,
  MemoryArchiveFile, MemoryCategory, MemoryScope,
} from "@hiagent/shared";
import type { ProjectStore } from "./project-store";
import {
  getGlobalMemoryStore,
  getProjectMemoryStore,
  createAmasterStore,
  projectNameFromCwd,
  type AmasterStore,
  type MemoryTarget,
} from "./amaster-memory";

const ARCHIVE_FILE = "memory-archive.json";
const HERMES_CONFIG_FILE = "hermes-memory-config.json";
const PROJECTS_MEMORY_DIR = "projects-memory";
const GLOBAL_REL_PREFIX = "memories/global";

/** amaster target → hiagent category */
function categoryForTarget(target: MemoryTarget): MemoryCategory {
  return target === "user" ? "user" : "memory";
}

/** 从 relPath 推断 target */
function targetFromRelPath(relPath: string): MemoryTarget {
  return relPath.replace(/\\/g, "/").endsWith("USER.md") ? "user" : "memory";
}

export interface MemoryStoreOpts {
  hiagentDir: string;
  projectStore: ProjectStore;
}

export class MemoryStore {
  constructor(private opts: MemoryStoreOpts) {}

  /**
   * 列出所有记忆 + 归档记忆
   * @param projectId 当前项目 ID；传入时额外读取对应项目记忆，不传则只返回全局记忆
   */
  async list(projectId?: string): Promise<{ memories: MemoryEntry[]; archived: ArchivedMemory[] }> {
    const memories: MemoryEntry[] = [];

    const globalStore = getGlobalMemoryStore(this.opts.hiagentDir);
    memories.push(...await this.toEntries(globalStore, "memory", "global", `${GLOBAL_REL_PREFIX}/MEMORY.md`));
    memories.push(...await this.toEntries(globalStore, "user", "global", `${GLOBAL_REL_PREFIX}/USER.md`));

    const cwd = projectId ? await this.getProjectCwd(projectId) : null;
    if (cwd) {
      // 项目记忆目录不可访问（如 cwd 为盘根/含非法字符、磁盘已移除）时，跳过项目记忆，
      // 仅返回全局记忆，避免整个列表抛错。
      try {
        const name = projectNameFromCwd(cwd);
        const projectStore = getProjectMemoryStore(this.opts.hiagentDir, cwd);
        const relBase = `${PROJECTS_MEMORY_DIR}/${name}`;
        memories.push(...await this.toEntries(projectStore, "memory", "project", `${relBase}/MEMORY.md`));
        memories.push(...await this.toEntries(projectStore, "user", "project", `${relBase}/USER.md`));
      } catch (err) {
        console.error(`[kernel] 读取项目记忆失败 (cwd=${cwd}):`, err);
      }
    }

    const archived = await this.loadArchive();
    return { memories, archived };
  }

  /** 把单个 store+target 的 entries 映射为 MemoryEntry[] */
  private async toEntries(
    store: AmasterStore,
    target: MemoryTarget,
    scope: MemoryScope,
    relPath: string,
  ): Promise<MemoryEntry[]> {
    const texts = await store.entries(target);
    const sourceFile = join(this.opts.hiagentDir, relPath);
    return texts.map((text, rawIndex) => ({
      id: `${relPath}:${rawIndex}`,
      text,
      category: categoryForTarget(target),
      scope,
      sourceFile,
      rawIndex,
    }));
  }

  /**
   * 手动添加记忆（UI「+ 添加」入口）。
   * 固定写入 memory target（USER target 由 agent / amaster 维护）。
   */
  async add(scope: MemoryScope, text: string, projectId?: string): Promise<void> {
    const store = await this.getStoreForScope(scope, projectId);
    await store.add("memory", text);
  }

  /** 编辑记忆：按 id 反查 store，取 oldText 调 amaster replace */
  async update(id: string, text: string): Promise<void> {
    const { store, target, oldText } = await this.resolveForMutation(id);
    const ok = await store.replace(target, oldText, text);
    if (!ok) throw new Error("条目不存在或已被修改，请刷新列表");
  }

  /** 归档（软删除）：从 store 移除 → 写入 sidecar */
  async archive(id: string): Promise<void> {
    const { store, target, oldText, meta } = await this.resolveForMutation(id);
    const ok = await store.remove(target, oldText);
    if (!ok) throw new Error("条目不存在或已被修改，请刷新列表");

    const archived = await this.loadArchive();
    archived.push({
      id,
      text: oldText,
      category: meta.category,
      scope: meta.scope,
      sourceFile: meta.sourceFile,
      rawIndex: meta.rawIndex,
      archivedAt: new Date().toISOString(),
    });
    await this.saveArchive(archived);
  }

  /** 恢复：从 sidecar 移除 → 追加回 store */
  async restore(id: string): Promise<void> {
    const archived = await this.loadArchive();
    const entry = archived.find(a => a.id === id);
    if (!entry) throw new Error("归档条目不存在");

    const store = createAmasterStore(dirname(entry.sourceFile));
    const target: MemoryTarget = entry.category === "user" ? "user" : "memory";
    await store.add(target, entry.text);
    await this.saveArchive(archived.filter(a => a.id !== id));
  }

  /** 彻底删除：从 sidecar 移除，不写回 store */
  async purge(id: string): Promise<void> {
    const archived = await this.loadArchive();
    await this.saveArchive(archived.filter(a => a.id !== id));
  }

  /** 扫描已加载的指令文件（全局 + 项目），仅 AGENTS.md / CLAUDE.md */
  async listInstructions(projectId: string): Promise<InstructionFile[]> {
    const result: InstructionFile[] = [];
    const candidates = ["AGENTS.md", "CLAUDE.md"];

    // 全局：~/.hiagent/AGENTS.md 或 CLAUDE.md（取第一个命中）
    for (const name of candidates) {
      const p = join(this.opts.hiagentDir, name);
      if (existsSync(p)) {
        result.push({ path: p, name, scope: "global", content: await readFile(p, "utf8") });
        break;
      }
    }

    // 项目级：cwd 下的 AGENTS.md 或 CLAUDE.md
    const cwd = await this.getProjectCwd(projectId);
    if (cwd) {
      for (const name of candidates) {
        const p = join(cwd, name);
        if (existsSync(p)) {
          result.push({ path: p, name, scope: "project", content: await readFile(p, "utf8") });
          break;
        }
      }
    }

    return result;
  }

  /** 读记忆配置开关 */
  async getConfig(): Promise<MemoryConfig> {
    try {
      const raw = await readFile(join(this.opts.hiagentDir, HERMES_CONFIG_FILE), "utf8");
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
    const configPath = join(this.opts.hiagentDir, HERMES_CONFIG_FILE);
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(await readFile(configPath, "utf8"));
    } catch {
      // 文件不存在，从空开始
    }
    if (opts.reviewEnabled !== undefined) existing.reviewEnabled = opts.reviewEnabled;
    if (opts.memoryPolicyStyle !== undefined) existing.memoryPolicyStyle = opts.memoryPolicyStyle;
    await mkdir(this.opts.hiagentDir, { recursive: true });
    await writeFile(configPath, JSON.stringify(existing, null, 2), "utf8");
  }

  // —— 辅助方法 ——

  /** 按 scope 取 store；project scope 必须能解析出 cwd，否则抛错 */
  private async getStoreForScope(scope: MemoryScope, projectId?: string): Promise<AmasterStore> {
    if (scope === "global") return getGlobalMemoryStore(this.opts.hiagentDir);
    if (!projectId) throw new Error("项目记忆需要 projectId");
    const cwd = await this.getProjectCwd(projectId);
    if (!cwd) throw new Error(`项目不存在: ${projectId}`);
    return getProjectMemoryStore(this.opts.hiagentDir, cwd);
  }

  /** 从 id 反查 store + target + 当前 oldText（变更前调用，保证命中最新文本） */
  private async resolveForMutation(id: string): Promise<{
    store: AmasterStore;
    target: MemoryTarget;
    oldText: string;
    meta: { category: MemoryCategory; scope: MemoryScope; sourceFile: string; rawIndex: number };
  }> {
    const colonIdx = id.lastIndexOf(":");
    if (colonIdx === -1) throw new Error(`无效的记忆 ID: ${id}`);
    const relPath = id.slice(0, colonIdx).replace(/\\/g, "/");
    const rawIndex = parseInt(id.slice(colonIdx + 1), 10);

    const target = targetFromRelPath(relPath);
    const scope: MemoryScope = relPath.startsWith(GLOBAL_REL_PREFIX) ? "global" : "project";
    const sourceFile = join(this.opts.hiagentDir, relPath);
    const store = createAmasterStore(dirname(sourceFile));

    const entries = await store.entries(target);
    const oldText = entries[rawIndex];
    if (oldText === undefined) {
      throw new Error("条目不存在或已被修改，请刷新列表");
    }
    return {
      store,
      target,
      oldText,
      meta: { category: categoryForTarget(target), scope, sourceFile, rawIndex },
    };
  }

  /** 按 projectId 从 ProjectStore 查 cwd */
  private async getProjectCwd(projectId: string): Promise<string | null> {
    const { projects } = await this.opts.projectStore.load();
    return projects.find(p => p.id === projectId)?.cwd ?? null;
  }

  /** 加载归档 sidecar */
  private async loadArchive(): Promise<ArchivedMemory[]> {
    try {
      const raw = await readFile(join(this.opts.hiagentDir, ARCHIVE_FILE), "utf8");
      const data = JSON.parse(raw) as MemoryArchiveFile;
      return data.entries ?? [];
    } catch {
      return [];
    }
  }

  /** 保存归档 sidecar */
  private async saveArchive(entries: ArchivedMemory[]): Promise<void> {
    await mkdir(this.opts.hiagentDir, { recursive: true });
    await writeFile(
      join(this.opts.hiagentDir, ARCHIVE_FILE),
      JSON.stringify({ entries } satisfies MemoryArchiveFile, null, 2),
      "utf8",
    );
  }
}
