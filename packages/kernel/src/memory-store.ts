// memory-store.ts — 记忆与指令文件管理服务
//
// 设计要点：
// - 读写 pi-hermes-memory 的 Markdown 文件（MEMORY.md/USER.md/failures.md），按 § 分隔条目
// - 归档使用 sidecar JSON（~/.hiagent/memory-archive.json），不修改插件的文件结构
// - 记忆配置开关读写 hermes-memory-config.json
// - 指令文件扫描全局（~/.hiagent）+ 项目 cwd 下的 AGENTS.md/CLAUDE.md
// - 与 pi-hermes-memory 之间无 API 调用，只通过文件系统通信

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type {
  MemoryEntry, ArchivedMemory, InstructionFile, MemoryConfig,
  MemoryArchiveFile, MemoryCategory, MemoryScope,
} from "@hiagent/shared";
import type { ProjectStore } from "./project-store";

/** 记忆文件来源定义 */
interface MemorySourceDef {
  relativePath: string;   // 相对于 hiagentDir 或 projectsMemoryDir 的路径
  category: MemoryCategory;
}

/** 全局记忆文件来源 */
const GLOBAL_SOURCES: MemorySourceDef[] = [
  { relativePath: "pi-hermes-memory/MEMORY.md", category: "memory" },
  { relativePath: "pi-hermes-memory/USER.md", category: "user" },
  { relativePath: "pi-hermes-memory/failures.md", category: "failure" },
];

/** 项目级记忆文件来源 */
const PROJECT_SOURCES: MemorySourceDef[] = [
  { relativePath: "MEMORY.md", category: "memory" },
  { relativePath: "failures.md", category: "failure" },
];

const ARCHIVE_FILE = "memory-archive.json";
const HERMES_CONFIG_FILE = "hermes-memory-config.json";
const PROJECTS_MEMORY_DIR = "projects-memory";

export interface MemoryStoreOpts {
  hiagentDir: string;
  projectStore: ProjectStore;
}

export class MemoryStore {
  constructor(private opts: MemoryStoreOpts) {}

  /** 列出所有记忆 + 归档记忆 */
  async list(): Promise<{ memories: MemoryEntry[]; archived: ArchivedMemory[] }> {
    const memories: MemoryEntry[] = [];
    const cwd = await this.getCurrentCwd();

    // 全局来源
    for (const src of GLOBAL_SOURCES) {
      const absPath = join(this.opts.hiagentDir, src.relativePath);
      const entries = await this.parseMemoryFile(absPath, src.category, "global");
      memories.push(...entries);
    }

    // 项目来源
    if (cwd) {
      const projectDir = join(this.opts.hiagentDir, PROJECTS_MEMORY_DIR, this.projectNameFromCwd(cwd));
      for (const src of PROJECT_SOURCES) {
        const absPath = join(projectDir, src.relativePath);
        const entries = await this.parseMemoryFile(absPath, src.category, "project");
        memories.push(...entries);
      }
    }

    // 归档
    const archived = await this.loadArchive();

    return { memories, archived };
  }

  /** 解析单个记忆文件的 § 分隔条目 */
  private async parseMemoryFile(
    absPath: string,
    category: MemoryCategory,
    scope: MemoryScope,
  ): Promise<MemoryEntry[]> {
    let content: string;
    try {
      content = await readFile(absPath, "utf8");
    } catch {
      return []; // 文件不存在，跳过
    }

    const parts = content.split("§").map(s => s.trim()).filter(s => s.length > 0);
    const relPath = relative(this.opts.hiagentDir, absPath).replace(/\\/g, "/");

    return parts.map((text, rawIndex) => ({
      id: `${relPath}:${rawIndex}`,
      text,
      category,
      scope,
      sourceFile: absPath,
      rawIndex,
    }));
  }

  // —— CRUD 方法在后续 step 实现 ——
  /** 编辑记忆：按 id 定位 § 段落，原地替换文本 */
  async update(id: string, text: string): Promise<void> {
    const sourceFile = await this.resolveSourceFile(id);
    const rawIndex = this.extractRawIndex(id);

    let content: string;
    try {
      content = await readFile(sourceFile, "utf8");
    } catch {
      throw new Error("记忆文件不存在，可能已被插件修改");
    }

    const parts = content.split("§");
    // 过滤空条目的索引对齐：与 parseMemoryFile 一致
    const nonEmptyIndices: number[] = [];
    parts.forEach((p, i) => { if (p.trim().length > 0) nonEmptyIndices.push(i); });

    const partIndex = nonEmptyIndices[rawIndex];
    if (partIndex === undefined) {
      throw new Error("条目不存在，可能已被插件修改，请刷新列表");
    }

    parts[partIndex] = text;
    await writeFile(sourceFile, parts.join("§"), "utf8");
  }

  /** 归档（软删除）：从源文件移除 → 写入 sidecar */
  async archive(id: string): Promise<void> {
    const sourceFile = await this.resolveSourceFile(id);
    const rawIndex = this.extractRawIndex(id);

    let content: string;
    try {
      content = await readFile(sourceFile, "utf8");
    } catch {
      throw new Error("记忆文件不存在");
    }

    const parts = content.split("§");
    const nonEmptyIndices: number[] = [];
    parts.forEach((p, i) => { if (p.trim().length > 0) nonEmptyIndices.push(i); });
    const partIndex = nonEmptyIndices[rawIndex];
    if (partIndex === undefined) throw new Error("条目不存在");

    const archivedText = parts[partIndex].trim();
    parts.splice(partIndex, 1);
    await writeFile(sourceFile, parts.join("§"), "utf8");

    // 写入 sidecar
    const archived = await this.loadArchive();
    const category = this.categoryFromSourceFile(sourceFile);
    const scope = this.scopeFromSourceFile(sourceFile);
    archived.push({
      id,
      text: archivedText,
      category,
      scope,
      sourceFile,
      rawIndex,
      archivedAt: new Date().toISOString(),
    });
    await this.saveArchive(archived);
  }

  /** 从文件路径推断分类 */
  private categoryFromSourceFile(absPath: string): MemoryCategory {
    const normalized = absPath.replace(/\\/g, "/");
    if (normalized.includes("USER.md")) return "user";
    if (normalized.includes("failures.md")) return "failure";
    return "memory";
  }

  /** 从文件路径推断作用域 */
  private scopeFromSourceFile(absPath: string): MemoryScope {
    const normalized = absPath.replace(/\\/g, "/");
    return normalized.includes(`${PROJECTS_MEMORY_DIR}/`) ? "project" : "global";
  }
  /** 恢复：从 sidecar 移除 → 追加回源文件末尾 */
  async restore(id: string): Promise<void> {
    const archived = await this.loadArchive();
    const entry = archived.find(a => a.id === id);
    if (!entry) throw new Error("归档条目不存在");

    // 追加回源文件
    let content = "";
    try {
      content = await readFile(entry.sourceFile, "utf8");
    } catch {
      // 文件可能不存在了（被插件清空），从空开始
    }
    const trimmed = content.trim();
    const newContent = trimmed.length > 0 ? `${trimmed}\n§\n${entry.text}` : entry.text;
    await mkdir(entry.sourceFile.replace(/[/\\][^/\\]+$/, ""), { recursive: true });
    await writeFile(entry.sourceFile, newContent, "utf8");

    // 从 sidecar 移除
    await this.saveArchive(archived.filter(a => a.id !== id));
  }
  /** 彻底删除：从 sidecar 移除，不写回源文件 */
  async purge(id: string): Promise<void> {
    const archived = await this.loadArchive();
    await this.saveArchive(archived.filter(a => a.id !== id));
  }
  async listInstructions(_projectId: string): Promise<InstructionFile[]> { return []; }
  async getConfig(): Promise<MemoryConfig> { return { reviewEnabled: true, memoryPolicyStyle: "full" }; }
  async setConfig(_opts: Partial<MemoryConfig>): Promise<void> {}

  // —— 辅助方法 ——

  /** 从 id（"相对路径:rawIndex"）提取 rawIndex */
  private extractRawIndex(id: string): number {
    const colonIdx = id.lastIndexOf(":");
    if (colonIdx === -1) throw new Error(`无效的记忆 ID: ${id}`);
    return parseInt(id.slice(colonIdx + 1), 10);
  }

  /** 从 id 解析源文件绝对路径 */
  private async resolveSourceFile(id: string): Promise<string> {
    const colonIdx = id.lastIndexOf(":");
    const relPath = id.slice(0, colonIdx).replace(/\//g, "/");
    // 尝试拼接 hiagentDir（全局或 projects-memory 下的路径都相对于 hiagentDir）
    return join(this.opts.hiagentDir, relPath);
  }

  /** 从 ProjectStore 拿当前项目 cwd */
  private async getCurrentCwd(): Promise<string | null> {
    const { projects } = await this.opts.projectStore.load();
    // 取第一个项目作为当前项目（简化：hiagent 单项目场景为主）
    // 实际使用时由 ws-server 传入 projectId 指定
    return projects[0]?.cwd ?? null;
  }

  /** 从 cwd 生成项目目录名（与 pi-hermes-memory 的 projects-memory/<basename> 对齐） */
  private projectNameFromCwd(cwd: string): string {
    // pi-hermes-memory 用 cwd 的 basename 作为项目标识
    const parts = cwd.replace(/\\/g, "/").replace(/\/$/, "").split("/");
    return parts[parts.length - 1] || "default";
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

  // 引用 HERMES_CONFIG_FILE，避免未使用告警（setConfig/getConfig 在后续 task 实现）
  protected readonly _configFile = HERMES_CONFIG_FILE;
}
