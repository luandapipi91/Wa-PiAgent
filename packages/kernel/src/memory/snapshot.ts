// 渲染注入系统提示词的 L1 块。
//
// 契约（规格 §6）：两个标题行不携带任何元数据（不显示字数/预算/窗口——
// 尤其不能再出现旧的 `[99% — 3,182/3,200 chars]`，它会诱导模型做无谓的删减
// 来"腾空间"）；RECENT MEMORY 只带条数；索引块只带条数与时间跨度 + 检索提示，
// 不列"最近：xxx"明细。
//
// 核心职责是"永远不出现写满"：超时间窗的条目自然下沉，进不了 L1 也不会消失，
// 只是改为按需检索（条数由索引块交代）。
import type { MemoryDao, MemoryKind, MemoryRow } from "./dao";
import { firstThreatMessage } from "./threat-patterns";

export interface SnapshotBudget {
  profile: number;
  knowledge: number;
  execution: number;
}

export const DEFAULT_SNAPSHOT_BUDGET: SnapshotBudget = {
  profile: 1800,
  knowledge: 1500,
  execution: 500,
};

export const DEFAULT_WINDOW_DAYS = 7;

export interface SnapshotContext {
  scope: "global" | "project";
  projectId: string | null;
  now?: number;
  windowDays?: number;
  budget?: SnapshotBudget;
}

const SEP = "═".repeat(46);
const ENTRY_DELIMITER = "\n§\n";

function header(label: string): string {
  return `${SEP}\n${label}\n${SEP}`;
}

/** 注入前扫描：命中防护的条目替换为占位符，防的是外部直写数据库绕过写入校验 */
function safeContent(row: MemoryRow): string {
  return firstThreatMessage(row.content, "strict")
    ? `[BLOCKED: ${row.id}]`
    : row.content;
}

/** 已选中的条目：text 是最终注入文本（BLOCKED 后以占位符计长，预算与实际输出一致） */
interface Picked {
  id: string;
  text: string;
}

/**
 * profile 块：全部 profile 条目按 updated_at DESC 填充，上限 budget。
 * 放不下的条目截断到剩余预算再停手——profile 是"用户是谁"，宁可截断也不能整条丢：
 * 它没有 L2/L3 那样的下沉层，丢掉就等于模型完全不知道用户画像。
 */
function pickProfile(rows: MemoryRow[], budget: number): Picked[] {
  const picked: Picked[] = [];
  let used = 0;
  for (const row of rows) {
    const room = budget - used;
    if (room <= 0) break;
    const text = safeContent(row);
    if (text.length <= room) {
      picked.push({ id: row.id, text });
      used += text.length;
    } else {
      picked.push({ id: row.id, text: text.slice(0, room) });
      used = budget;
    }
  }
  return picked;
}

/**
 * RECENT 块：窗口内的 knowledge / execution 各按自己的配额填充。
 * 放不下的跳过而不是截断——它不丢失，只是下沉到 L2/L3 并计入索引块条数
 * （"超出"的语义是下沉，不是丢弃更不是报错）。
 */
function pickRecent(rows: MemoryRow[], budget: SnapshotBudget): Picked[] {
  const picked: Picked[] = [];
  const used: Record<"knowledge" | "execution", number> = { knowledge: 0, execution: 0 };
  for (const row of rows) {
    const kind = row.kind as "knowledge" | "execution";
    const text = safeContent(row);
    if (used[kind] + text.length > budget[kind]) continue;
    picked.push({ id: row.id, text });
    used[kind] += text.length;
  }
  return picked;
}

function block(label: string, picked: Picked[]): string {
  if (!picked.length) return "";
  return `${header(label)}\n${picked.map((p) => p.text).join(ENTRY_DELIMITER)}`;
}

/**
 * 索引块：只报条数与时间跨度，固定几十字、不随条目数增长。
 * 条数回答"还有多少没看到"（决定是否值得发起检索）；明细与已注入内容重复，故不列。
 * 时间跨度取被计数的 L2/L3 条目里最早的一条——索引块描述的就是这层，不掺 profile。
 */
function renderIndex(rest: MemoryRow[]): string {
  const l2 = rest.filter((r) => r.kind === "knowledge").length;
  const l3 = rest.filter((r) => r.kind === "execution").length;
  if (l2 === 0 && l3 === 0) return "";

  const oldest = Math.min(...rest.filter((r) => r.kind !== "profile").map((r) => r.updatedAt));
  const head = [
    l2 ? `L2 长期知识 ${l2} 条` : "",
    l3 ? `L3 执行记忆 ${l3} 条` : "",
    // 用 UTC 日期，保证同一时间戳在任何时区渲染结果一致
    `${new Date(oldest).toISOString().slice(0, 10)} 至今`,
  ].filter(Boolean).join(" | ");

  return `[${head}]\n[需要更多记忆时用 memory_search 检索]`;
}

/** 渲染 L1 快照；无任何记忆时返回空串（调用方据此整段不注入） */
export function renderSnapshot(dao: MemoryDao, ctx: SnapshotContext): string {
  const now = ctx.now ?? Date.now();
  const windowDays = ctx.windowDays ?? DEFAULT_WINDOW_DAYS;
  const budget = ctx.budget ?? DEFAULT_SNAPSHOT_BUDGET;
  const windowStart = now - windowDays * 86_400_000;

  const all = dao.list({ scope: ctx.scope, projectId: ctx.projectId, includeArchived: false });
  if (all.length === 0) return "";

  // dao.list 已按 updated_at DESC 排序，同时间戳时保持库内顺序即选取优先级
  const profileRows = all.filter((r) => r.kind === "profile");
  const inWindow = all.filter((r) => r.kind !== "profile" && r.updatedAt >= windowStart);

  const pickedProfile = pickProfile(profileRows, budget.profile);
  const pickedRecent = pickRecent(inWindow, budget);

  // 注入过的条目要排除出索引计数：已注入的不算"下沉"，否则索引会重复报数
  const injected = new Set([...pickedProfile, ...pickedRecent].map((p) => p.id));
  const rest = all.filter((r) => !injected.has(r.id));

  return [
    block("USER PROFILE (who the user is)", pickedProfile),
    block(`RECENT MEMORY [${pickedRecent.length} 条]`, pickedRecent),
    renderIndex(rest),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** kind → 人类可读标签（UI 与日志复用） */
export const KIND_LABEL: Record<MemoryKind, string> = {
  profile: "用户画像",
  knowledge: "知识",
  execution: "执行",
};
