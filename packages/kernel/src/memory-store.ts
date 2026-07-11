// memory-store.ts — 记忆与指令文件管理服务
//
// 设计要点：
// - 读写 pi-hermes-memory 的 Markdown 文件（MEMORY.md/USER.md/failures.md），按 § 分隔条目
// - 归档使用 sidecar JSON（~/.hiagent/memory-archive.json），不修改插件的文件结构
// - 记忆配置开关读写 hermes-memory-config.json
// - 指令文件扫描全局（~/.hiagent）+ 项目 cwd 下的 AGENTS.md/CLAUDE.md
// - 与 pi-hermes-memory 之间无 API 调用，只通过文件系统通信

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
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

/** 匹配 HTML 注释（支持多行） */
const HTML_COMMENT_REGEX = /<!--[\s\S]*?-->/g;

/** 移除文本中的 HTML 注释，并尝试提取最后修改日期（优先 last， fallback created） */
function stripHtmlComments(text: string): { text: string; updatedAt?: string } {
  let updatedAt: string | undefined;
  const cleaned = text.replace(HTML_COMMENT_REGEX, (match) => {
    const lastMatch = match.match(/last=(\d{4}-\d{2}-\d{2})/);
    if (lastMatch) {
      updatedAt = lastMatch[1];
    } else {
      const createdMatch = match.match(/created=(\d{4}-\d{2}-\d{2})/);
      if (createdMatch && !updatedAt) updatedAt = createdMatch[1];
    }
    return "";
  });
  return { text: cleaned, updatedAt };
}

/** 判断去除 HTML 注释后是否为空条目（与 parse 对齐） */
function isEmptyMemoryPart(text: string): boolean {
  return stripHtmlComments(text).text.trim().length === 0;
}

/** 替换正文时保留原始 part 末尾的 HTML 注释元数据 */
function replaceTextKeepingComment(originalPart: string, newText: string): string {
  const commentMatch = originalPart.match(/(<!--[\s\S]*?-->)/);
  if (!commentMatch) return newText;
  const comment = commentMatch[1];
  const beforeComment = originalPart.slice(0, commentMatch.index).trimEnd();
  const prefixEnd = beforeComment.length > 0 ? originalPart.indexOf(beforeComment) : commentMatch.index;
  const prefix = originalPart.slice(0, prefixEnd);
  return `${prefix}${newText}\n${comment}`;
}

export interface MemoryStoreOpts {
  hiagentDir: string;
  projectStore: ProjectStore;
}

export class MemoryStore {
  constructor(private opts: MemoryStoreOpts) {}

  /** 列出所有记忆 + 归档记忆
   * @param projectId 当前项目 ID；传入时读取对应项目的 projects-memory，不传则只返回全局记忆
   */
  async list(projectId?: string): Promise<{ memories: MemoryEntry[]; archived: ArchivedMemory[] }> {
    const memories: MemoryEntry[] = [];

    // 全局来源
    for (const src of GLOBAL_SOURCES) {
      const absPath = join(this.opts.hiagentDir, src.relativePath);
      const entries = await this.parseMemoryFile(absPath, src.category, "global");
      memories.push(...entries);
    }

    // 项目来源
    const cwd = projectId ? await this.getProjectCwd(projectId) : null;
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

    const parts = content.split("§");
    const relPath = relative(this.opts.hiagentDir, absPath).replace(/\\/g, "/");

    // 过滤空/纯注释条目，rawIndex 与 update/archive 的 nonEmptyIndices 对齐
    const nonEmptyParts = parts
      .map((text, originalIdx) => ({ text, originalIdx }))
      .filter(({ text }) => !isEmptyMemoryPart(text));

    return nonEmptyParts.map(({ text }, rawIndex) => {
      const stripped = stripHtmlComments(text);
      return {
        id: `${relPath}:${rawIndex}`,
        text: stripped.text.trim(),
        category,
        scope,
        sourceFile: absPath,
        rawIndex,
        updatedAt: stripped.updatedAt,
      };
    });
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
    // 过滤空/纯注释条目的索引对齐：与 parseMemoryFile 一致
    const nonEmptyIndices: number[] = [];
    parts.forEach((p, i) => { if (!isEmptyMemoryPart(p)) nonEmptyIndices.push(i); });

    const partIndex = nonEmptyIndices[rawIndex];
    if (partIndex === undefined) {
      throw new Error("条目不存在，可能已被插件修改，请刷新列表");
    }

    parts[partIndex] = replaceTextKeepingComment(parts[partIndex], text);
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
    parts.forEach((p, i) => { if (!isEmptyMemoryPart(p)) nonEmptyIndices.push(i); });
    const partIndex = nonEmptyIndices[rawIndex];
    if (partIndex === undefined) throw new Error("条目不存在");

    const archivedText = stripHtmlComments(parts[partIndex]).text.trim();
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
  /** 扫描已加载的指令文件（全局 + 项目） */
  async listInstructions(projectId: string): Promise<InstructionFile[]> {
    const result: InstructionFile[] = [];
    const candidates = ["AGENTS.md", "CLAUDE.md"];

    // 全局：~/.hiagent/AGENTS.md 或 CLAUDE.md（取第一个命中）
    for (const name of candidates) {
      const p = join(this.opts.hiagentDir, name);
      if (existsSync(p)) {
        result.push({
          path: p, name, scope: "global",
          content: await readFile(p, "utf8"),
        });
        break;
      }
    }

    // 项目级：cwd 下的 AGENTS.md 或 CLAUDE.md
    const cwd = await this.getProjectCwd(projectId);
    if (cwd) {
      for (const name of candidates) {
        const p = join(cwd, name);
        if (existsSync(p)) {
          result.push({
            path: p, name, scope: "project",
            content: await readFile(p, "utf8"),
          });
          break;
        }
      }
    }

    // 全局记忆文件也作为参考指令注入（MEMORY.md / USER.md / failures.md）
    for (const src of GLOBAL_SOURCES) {
      const p = join(this.opts.hiagentDir, src.relativePath);
      if (existsSync(p)) {
        const content = await readFile(p, "utf8");
        if (content.trim()) {
          const name = src.relativePath.replace(/\\/g, "/").split("/").pop() ?? src.relativePath;
          result.push({ path: p, name, scope: "global", content });
        }
      }
    }

    // 项目级记忆文件
    if (cwd) {
      const projectDir = join(this.opts.hiagentDir, PROJECTS_MEMORY_DIR, this.projectNameFromCwd(cwd));
      for (const src of PROJECT_SOURCES) {
        const p = join(projectDir, src.relativePath);
        if (existsSync(p)) {
          const content = await readFile(p, "utf8");
          if (content.trim()) {
            result.push({ path: p, name: src.relativePath, scope: "project", content });
          }
        }
      }
    }

    return result;
  }

  /** 按 projectId 从 ProjectStore 查 cwd */
  private async getProjectCwd(projectId: string): Promise<string | null> {
    const { projects } = await this.opts.projectStore.load();
    return projects.find(p => p.id === projectId)?.cwd ?? null;
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
}
