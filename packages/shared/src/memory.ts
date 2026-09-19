// ===== 记忆与指令文件管理类型定义 =====

/** 记忆作用域：来自文件路径 */
export type MemoryScope = "global" | "project";

/** 记忆层级（DB 模式）：profile 常驻画像 / knowledge 知识 / execution 执行记录 */
export type MemoryKind = "profile" | "knowledge" | "execution";

/** 一条记忆条目 */
export interface MemoryEntry {
  id: string; // DB 模式：uuid（不透明字符串）
  text: string; // 记忆正文
  scope: MemoryScope;
  kind: MemoryKind; // 记忆层级
  createdAt: string; // 创建时间（ISO）
  updatedAt?: string; // 最后修改时间（ISO）
  projectId?: string; // 项目名（DB 模式的 project_id 列）
  /** @deprecated DB 模式下无文件来源，恒为 undefined */
  sourceFile?: string;
  /** @deprecated DB 模式下无下标，恒为 undefined */
  rawIndex?: number;
}

/** 检索结果条目（GET /api/memories/search，spec §5） */
export interface MemorySearchResult {
  id: string;
  title: string;
  snippet: string;
  kind: MemoryKind;
  scope: MemoryScope;
  projectId?: string;
  updatedAt: string; // ISO
  score: number;
  archived: boolean;
}

/** 归档的记忆（sidecar 记录） */
export interface ArchivedMemory extends MemoryEntry {
  archivedAt: string;
}

/** 指令文件 */
export interface InstructionFile {
  path: string; // 绝对路径
  name: string; // AGENTS.md / CLAUDE.md
  scope: MemoryScope;
  content: string; // 文件全文（UI 截取摘要）
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
export interface MemoryListEvent {
  type: "memory:list";
  projectId: string;
}
export interface MemoryUpdateEvent {
  type: "memory:update";
  projectId: string;
  entryId: string;
  text: string;
}
export interface MemoryArchiveEvent {
  type: "memory:archive";
  projectId: string;
  entryId: string;
}
export interface MemoryRestoreEvent {
  type: "memory:restore";
  projectId: string;
  entryId: string;
}
export interface MemoryPurgeEvent {
  type: "memory:purge";
  projectId: string;
  entryId: string;
}
export interface MemoryAddEvent {
  type: "memory:add";
  /** 写入作用域：global 全局，project 当前项目（需带 projectId） */
  scope: MemoryScope;
  /** scope=project 时必填，定位项目 cwd */
  projectId?: string;
  /** 记忆正文 */
  text: string;
}
export interface InstructionListEvent {
  type: "instruction:list";
  projectId: string;
}
export interface MemorySearchEvent {
  type: "memory:search";
  query: string;
  /** 空串视为未指定（ws-server 分发处归一为 undefined） */
  scope?: MemoryScope | "";
  kind?: MemoryKind | "";
  /** UI 侧项目 id（分发处解析为项目名后查库） */
  projectId?: string;
  limit?: number;
  includeArchived?: boolean;
  /** 只看归档条目；与 includeArchived 同时给出时以本字段为准 */
  archivedOnly?: boolean;
  /** 时间下界（含端点，毫秒时间戳，按 updated_at 过滤） */
  since?: number;
  /** 时间上界（含端点，毫秒时间戳，按 updated_at 过滤） */
  until?: number;
  /** 分页偏移：跳过前 N 条命中（滚动加载用） */
  offset?: number;
}
export interface MemoryConfigGetEvent {
  type: "memory:config:get";
}
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
export interface MemorySearchResultEvent {
  type: "memory:search";
  results: MemorySearchResult[];
  /** 真实命中总数（未截断）：可能大于 results.length（limit / 候选上限截断）。spec §5 */
  totalMatched: number;
  /** 是否还有下一页（候选池拉满即视为可能有） */
  hasMore: boolean;
}
export interface InstructionListResult {
  type: "instruction:list";
  instructions: InstructionFile[];
}
export interface MemoryConfigEvent {
  type: "memory:config";
  config: MemoryConfig;
}

// ===== 记忆列表分页（UI 滚动加载）=====
export interface MemoryListPageEvent {
  type: "memory:list:page";
  /** 列表作用域：global 全局段，project 项目段（与 UI 的 memoryScope 二选一直传） */
  scope: MemoryScope;
  /** scope=project 时必填（UI 侧项目 id，内核解析为项目名） */
  projectId?: string;
  /** 列表所在 Tab：active 已保存 / archived 归档 */
  tab: "active" | "archived";
  /** 层级筛选；缺省不筛 */
  kind?: MemoryKind;
  /** 时间下界（含端点，毫秒，按 updated_at）；缺省不设 */
  since?: number;
  /** 时间上界（含端点，毫秒，按 updated_at）；缺省不设 */
  until?: number;
  /** 分页偏移 */
  offset?: number;
  /** 每页条数（必填：带 limit 是分页模式的唯一入口标识） */
  limit: number;
}

export interface MemoryListPageResult {
  type: "memory:list:page";
  /** 当前页条目（tab=archived 时条目带 archivedAt，为 ArchivedMemory） */
  entries: MemoryEntry[];
  /** 是否还有下一页 */
  hasMore: boolean;
  /** 徽标口径计数：不带 kind/时间窗的全量总数（active 与 archived 各自） */
  counts: { active: number; archived: number };
}
