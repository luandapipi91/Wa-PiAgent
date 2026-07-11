// ===== 记忆与指令文件管理类型定义 =====

/** 记忆分类：来自文件来源 */
export type MemoryCategory = "memory" | "user" | "failure";

/** 记忆作用域：来自文件路径 */
export type MemoryScope = "global" | "project";

/** 一条记忆条目 */
export interface MemoryEntry {
  id: string;                    // 格式："源文件相对路径:rawIndex"
  text: string;                  // § 分隔后的单条文本
  category: MemoryCategory;
  scope: MemoryScope;
  sourceFile: string;            // 源文件绝对路径
  rawIndex: number;              // 在源文件 § 分隔后的索引（0-based）
  updatedAt?: string;            // 最后修改时间（来自 sidecar，可选）
}

/** 归档的记忆（sidecar 记录） */
export interface ArchivedMemory extends MemoryEntry {
  archivedAt: string;
}

/** 指令文件 */
export interface InstructionFile {
  path: string;                  // 绝对路径
  name: string;                  // AGENTS.md / CLAUDE.md
  scope: MemoryScope;
  content: string;               // 文件全文（UI 截取摘要）
}

/** 记忆配置（开关状态） */
export interface MemoryConfig {
  reviewEnabled: boolean;
  memoryPolicyStyle: "full" | "compact" | "none";
}

/** 归档 sidecar 结构 */
export interface MemoryArchiveFile {
  entries: ArchivedMemory[];
}

// ===== WS 协议事件（记忆管理）=====

// 前端 → kernel
export interface MemoryListEvent { type: "memory:list"; }
export interface MemoryUpdateEvent {
  type: "memory:update";
  entryId: string;
  text: string;
}
export interface MemoryArchiveEvent {
  type: "memory:archive";
  entryId: string;
}
export interface MemoryRestoreEvent {
  type: "memory:restore";
  entryId: string;
}
export interface MemoryPurgeEvent {
  type: "memory:purge";
  entryId: string;
}
export interface InstructionListEvent {
  type: "instruction:list";
  projectId: string;
}
export interface MemoryConfigGetEvent { type: "memory:config:get"; }
export interface MemoryConfigSetEvent {
  type: "memory:config:set";
  reviewEnabled?: boolean;
  memoryPolicyStyle?: "full" | "compact" | "none";
}

// kernel → 前端
export interface MemoryListResult {
  type: "memory:list";
  memories: MemoryEntry[];
  archived: ArchivedMemory[];
}
export interface MemoryUpdateResult {
  type: "memory:update";
  ok: boolean;
}
export interface MemoryChangedEvent {
  type: "memory:changed";
  memories: MemoryEntry[];
  archived: ArchivedMemory[];
}
export interface InstructionListResult {
  type: "instruction:list";
  instructions: InstructionFile[];
}
export interface MemoryConfigEvent {
  type: "memory:config";
  config: MemoryConfig;
}
