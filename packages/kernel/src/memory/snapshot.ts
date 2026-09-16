// 渲染注入系统提示词的 L1 块。
//
// 契约（规格 §6）：两个标题行不携带任何元数据（不显示字数/预算/窗口——
// 尤其不能再出现旧的 `[99% — 3,182/3,200 chars]`，它会诱导模型做无谓的删减
// 来"腾空间"）；RECENT MEMORY 只带条数；索引块只带条数与时间跨度 + 检索提示，
// 不列"最近：xxx"明细。
//
// 核心职责是"永远不出现写满"：超时间窗的条目自然下沉，进不了 L1 也不会消失，
// 只是改为按需检索（条数由索引块交代）。
import type { ListOpts, MemoryDao, MemoryKind, MemoryRow } from "./dao";
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
  kind: MemoryKind;
  text: string;
}

/**
 * L1 单层取数上界。
 *
 * 真正可能被注入的量受预算约束（profile 1800 / knowledge 1500 / execution 500 字符），
 * 这里只是给一个宽裕的上界：既不把整个 scope 的行连全文载入内存（多年使用或一次性
 * 导入一个巨大 MEMORY.md 后可能有上万条），也不影响预算内的选取结果。
 * 超过上界的条目不会被丢弃 —— 它们照旧计入索引块的条数（下沉语义）。
 */
const L1_SCAN_LIMIT = 500;

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
      picked.push({ id: row.id, kind: row.kind, text });
      used += text.length;
    } else {
      picked.push({ id: row.id, kind: row.kind, text: text.slice(0, room) });
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
  const used: Record<"knowledge" | "execution", number> = {
    knowledge: 0,
    execution: 0,
  };
  for (const row of rows) {
    const kind = row.kind as "knowledge" | "execution";
    const text = safeContent(row);
    if (used[kind] + text.length > budget[kind]) continue;
    picked.push({ id: row.id, kind, text });
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
 *
 * 条数来自 SQL 聚合（总量 − 已注入），时间跨度来自 MIN 查询：都不载入行，
 * 条目上万时也不会把整个 scope 读进内存、更不会因 Math.min(...spread) 报 RangeError。
 */
function renderIndex(l2: number, l3: number, oldest: number | null): string {
  if (l2 === 0 && l3 === 0) return "";

  const head = [
    l2 ? `L2 长期知识 ${l2} 条` : "",
    l3 ? `L3 执行记忆 ${l3} 条` : "",
    // 用 UTC 日期，保证同一时间戳在任何时区渲染结果一致
    oldest === null
      ? ""
      : `${new Date(oldest).toISOString().slice(0, 10)} 至今`,
  ]
    .filter(Boolean)
    .join(" | ");

  return `[${head}]\n[需要更多记忆时用 memory_search 检索]`;
}

/**
 * 索引块描述的"下沉"集合 = 该 scope 全部 L2/L3 − 已注入的，时间跨度取其最早一条。
 *
 * 不载入全部行也能算准：
 * 1. 只要存在超窗口条目，最早的一条必在其中（窗口内的都比它新）→ 一次 MIN 查询即可
 * 2. 没有超窗口条目且取数被上界截断时，被截断的那批行只会更早、且都在下沉集合里 → 用全量 MIN
 * 3. 否则已载入的行就是全部窗口行 → 在内存里取「未被注入」的最早一条
 */
function oldestDownsunk(
  dao: MemoryDao,
  filter: ListOpts,
  windowStart: number,
  inWindow: MemoryRow[],
  pickedRecent: Picked[],
  truncated: boolean,
): number | null {
  const outOfWindow = dao.oldestUpdatedAt({
    ...filter,
    excludeProfile: true,
    before: windowStart,
  });
  if (outOfWindow !== null) return outOfWindow;
  if (truncated)
    return dao.oldestUpdatedAt({ ...filter, excludeProfile: true });

  const injected = new Set(pickedRecent.map((p) => p.id));
  let oldest: number | null = null;
  for (const row of inWindow) {
    if (injected.has(row.id)) continue;
    if (oldest === null || row.updatedAt < oldest) oldest = row.updatedAt;
  }
  return oldest;
}

/** 渲染 L1 快照；无任何记忆时返回空串（调用方据此整段不注入） */
export function renderSnapshot(dao: MemoryDao, ctx: SnapshotContext): string {
  const now = ctx.now ?? Date.now();
  const windowDays = ctx.windowDays ?? DEFAULT_WINDOW_DAYS;
  // 合并默认值：调用方只给部分字段时，未给的层回落默认配额。
  // 直接 `ctx.budget ?? DEFAULT` 会让缺字段的层得到 undefined 配额 —— 比较恒 false
  // 就等于该层完全不设上限（静默取消配额），必须在入口处补全。
  const budget = { ...DEFAULT_SNAPSHOT_BUDGET, ...ctx.budget };
  const windowStart = now - windowDays * 86_400_000;
  const filter: ListOpts = {
    scope: ctx.scope,
    projectId: ctx.projectId,
    includeArchived: false,
  };

  // 索引块条数与"有没有记忆"都走聚合查询：不载入全文，也不因 L1 取数上界而算错
  const totals = dao.counts(filter);
  if (totals.profile + totals.knowledge + totals.execution === 0) return "";

  // L1 三段各自带上界取数；dao.list 已按 updated_at DESC 排序
  const profileRows = dao.list({
    ...filter,
    kind: "profile",
    limit: L1_SCAN_LIMIT,
  });
  const knowledgeRows = dao.list({
    ...filter,
    kind: "knowledge",
    limit: L1_SCAN_LIMIT,
  });
  const executionRows = dao.list({
    ...filter,
    kind: "execution",
    limit: L1_SCAN_LIMIT,
  });
  // 取满上界即视为被截断（更早的行没进内存）；只影响索引块的时间跨度取值，不影响条数
  const truncated =
    knowledgeRows.length === L1_SCAN_LIMIT ||
    executionRows.length === L1_SCAN_LIMIT;
  const inWindow = [...knowledgeRows, ...executionRows]
    .filter((r) => r.updatedAt >= windowStart)
    .sort((a, b) => b.updatedAt - a.updatedAt);

  const pickedProfile = pickProfile(profileRows, budget.profile);
  const pickedRecent = pickRecent(inWindow, budget);

  // 索引块的条数 = 总量 − 已注入的（已注入的不算"下沉"，否则索引会重复报数）
  const injectedKnowledge = pickedRecent.filter(
    (p) => p.kind === "knowledge",
  ).length;
  const injectedExecution = pickedRecent.filter(
    (p) => p.kind === "execution",
  ).length;
  const l2 = totals.knowledge - injectedKnowledge;
  const l3 = totals.execution - injectedExecution;
  const oldest =
    l2 > 0 || l3 > 0
      ? oldestDownsunk(
          dao,
          filter,
          windowStart,
          inWindow,
          pickedRecent,
          truncated,
        )
      : null;

  return [
    block("USER PROFILE (who the user is)", pickedProfile),
    block(`RECENT MEMORY [${pickedRecent.length} 条]`, pickedRecent),
    renderIndex(l2, l3, oldest),
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
