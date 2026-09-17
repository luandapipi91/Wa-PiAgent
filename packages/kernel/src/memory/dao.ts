// 记忆库唯一读写入口。
//
// 关键约束：FTS 同步完全由本层负责（不用触发器——SQLite 触发器调不到 JS 的
// bigram 函数）。任何改写 content/title/tags 的路径都必须调 syncFts()，
// 删除路径必须清掉对应 FTS 行。
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { bigram } from "./bigram";
import { buildMatchExpr } from "./query";

export type MemoryKind = "profile" | "knowledge" | "execution";
export type MemoryTarget = "user" | "memory";
export type MemoryScope = "global" | "project";

export interface MemoryRow {
  id: string;
  kind: MemoryKind;
  target: MemoryTarget;
  scope: MemoryScope;
  projectId: string | null;
  content: string;
  title: string;
  tags: string;
  source: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  useCount: number;
  archived: number;
  archivedAt: number | null;
}

export interface InsertInput {
  kind: MemoryKind;
  target: MemoryTarget;
  scope: MemoryScope;
  projectId?: string | null;
  content: string;
  title?: string;
  tags?: string;
  source: string;
}

export interface ListOpts {
  scope?: MemoryScope;
  projectId?: string | null;
  kind?: MemoryKind;
  includeArchived?: boolean;
  /** 只看归档；与 includeArchived 互斥、本字段优先 */
  archivedOnly?: boolean;
  /** 最多取多少行（快照 L1 用：只取预算够用的量，不把整个 scope 载入内存） */
  limit?: number;
  /** 时间下界（含端点，毫秒时间戳）；undefined 即不设该边界 */
  since?: number;
  /** 时间上界（含端点，毫秒时间戳）；undefined 即不设该边界 */
  until?: number;
  /** since/until 依据的时间列（默认 updated_at）；只在设了边界时有意义 */
  timeField?: "updated" | "created";
}

export interface SearchOpts extends ListOpts {
  limit?: number;
  /** 排序权重（默认 1.0 / 0.5 / 0.3，见规格 §5） */
  weights?: { bm25: number; time: number; kind: number };
  /** 时间衰减半衰期（天，默认 30） */
  halfLifeDays?: number;
  now?: number;
}

export interface SearchHit extends MemoryRow {
  score: number;
  snippet: string;
}

const KIND_BOOST: Record<MemoryKind, number> = {
  profile: 1.0,
  knowledge: 0.9,
  execution: 0.6,
};

const TITLE_MAX = 60;
const SNIPPET_RADIUS = 40;
const CANDIDATE_LIMIT = 50;

/** 从内容提取标题：首个非空行截断 */
export function deriveTitle(content: string): string {
  const firstLine = content.split(/\r?\n/).find((l) => l.trim()) ?? content;
  const t = firstLine.trim();
  return t.length > TITLE_MAX ? t.slice(0, TITLE_MAX) : t;
}

/** 摘取片段：优先围绕首个命中 token，否则取开头 */
export function makeSnippet(content: string, rawQuery: string): string {
  const tokens = bigram(rawQuery).split(/\s+/).filter(Boolean);
  const lower = content.toLowerCase();
  let at = -1;
  for (const t of tokens) {
    const i = lower.indexOf(t.toLowerCase());
    if (i !== -1 && (at === -1 || i < at)) at = i;
  }
  if (at === -1) {
    return content.length > SNIPPET_RADIUS * 2
      ? content.slice(0, SNIPPET_RADIUS * 2)
      : content;
  }
  const start = Math.max(0, at - SNIPPET_RADIUS);
  return content.slice(start, start + SNIPPET_RADIUS * 2);
}

interface RawRow {
  id: string;
  kind: string;
  target: string;
  scope: string;
  project_id: string | null;
  content: string;
  title: string;
  tags: string;
  source: string;
  created_at: number;
  updated_at: number;
  last_used_at: number | null;
  use_count: number;
  archived: number;
  archived_at: number | null;
}

function toRow(r: RawRow): MemoryRow {
  return {
    id: r.id,
    kind: r.kind as MemoryKind,
    target: r.target as MemoryTarget,
    scope: r.scope as MemoryScope,
    projectId: r.project_id,
    content: r.content,
    title: r.title,
    tags: r.tags,
    source: r.source,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastUsedAt: r.last_used_at,
    useCount: r.use_count,
    archived: r.archived,
    archivedAt: r.archived_at,
  };
}

export class MemoryDao {
  constructor(readonly db: Database) {}

  insert(input: InsertInput): MemoryRow {
    const now = Date.now();
    const id = randomUUID();
    const title = input.title?.trim() || deriveTitle(input.content);
    this.db.run(
      `INSERT INTO memories
         (id, kind, target, scope, project_id, content, title, tags, source,
          created_at, updated_at, last_used_at, use_count, archived, archived_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,0,0,NULL)`,
      [
        id,
        input.kind,
        input.target,
        input.scope,
        input.projectId ?? null,
        input.content,
        title,
        input.tags ?? "",
        input.source,
        now,
        now,
      ],
    );
    const row = this.getById(id)!;
    this.syncFts(row);
    return row;
  }

  getById(id: string): MemoryRow | null {
    const r = this.db
      .query("SELECT * FROM memories WHERE id = ?")
      .get(id) as RawRow | null;
    return r ? toRow(r) : null;
  }

  /** 按内容子串查找（memory_replace/remove 无 id 时的兼容路径） */
  findBySubstring(text: string, opts: ListOpts = {}): MemoryRow[] {
    const trimmed = text.trim();
    if (!trimmed) return [];
    return this.list({
      ...opts,
      includeArchived: opts.includeArchived ?? false,
    }).filter((r) => r.content.includes(trimmed));
  }

  updateContent(id: string, content: string): boolean {
    const now = Date.now();
    const res = this.db.run(
      "UPDATE memories SET content = ?, title = ?, updated_at = ? WHERE id = ?",
      [content, deriveTitle(content), now, id],
    );
    if (res.changes === 0) return false;
    this.syncFts(this.getById(id)!);
    return true;
  }

  remove(id: string): boolean {
    const res = this.db.run("DELETE FROM memories WHERE id = ?", [id]);
    if (res.changes === 0) return false;
    this.db.run("DELETE FROM memories_fts WHERE memory_id = ?", [id]);
    return true;
  }

  archive(id: string): boolean {
    const res = this.db.run(
      "UPDATE memories SET archived = 1, archived_at = ? WHERE id = ? AND archived = 0",
      [Date.now(), id],
    );
    return res.changes > 0;
  }

  restore(id: string): boolean {
    // 只翻状态，不动 updated_at：恢复归档是状态变更而非内容更新，
    // 不得伪造新近性（L1 常驻选取按 updated_at 窗口、list 按 updated_at 排序、
    // search 时间衰减以 updated_at 为基准）。archive 同样不动 updated_at，两者对称。
    const res = this.db.run(
      "UPDATE memories SET archived = 0, archived_at = NULL WHERE id = ? AND archived = 1",
      [id],
    );
    return res.changes > 0;
  }

  /** 彻底删除归档条目（与 remove 同义，保留给 UI 的 purge 语义） */
  purge(id: string): boolean {
    return this.remove(id);
  }

  list(opts: ListOpts = {}): MemoryRow[] {
    const { where, params } = this.buildFilter(opts);
    const limit =
      typeof opts.limit === "number" && opts.limit > 0
        ? ` LIMIT ${Math.floor(opts.limit)}`
        : "";
    const rows = this.db
      .query(`SELECT * FROM memories ${where} ORDER BY updated_at DESC${limit}`)
      .all(...params) as RawRow[];
    return rows.map(toRow);
  }

  counts(opts: ListOpts = {}): Record<MemoryKind, number> {
    const { where, params } = this.buildFilter(opts);
    const rows = this.db
      .query(`SELECT kind, COUNT(*) AS n FROM memories ${where} GROUP BY kind`)
      .all(...params) as Array<{ kind: string; n: number }>;
    const out: Record<MemoryKind, number> = {
      profile: 0,
      knowledge: 0,
      execution: 0,
    };
    for (const r of rows) {
      if (r.kind in out) out[r.kind as MemoryKind] = r.n;
    }
    return out;
  }

  /**
   * 指定过滤下最早的 updated_at（无行返回 null）。
   *
   * 快照索引块只为算一个「时间跨度」，不该为此把整个 scope 的行连全文读进内存
   * （上万条时既费内存，`Math.min(...rows.map(...))` 的展开还会直接 RangeError）。
   * excludeProfile：索引块描述 L2/L3，不掺用户画像。
   * before：只看某时间点之前的行（快照用它先求「超窗口」集合的最早时间）。
   */
  oldestUpdatedAt(
    opts: ListOpts & { excludeProfile?: boolean; before?: number } = {},
  ): number | null {
    const { where, params } = this.buildFilter(opts);
    const extra: string[] = [];
    if (opts.excludeProfile) extra.push("kind <> 'profile'");
    if (opts.before !== undefined) {
      extra.push("updated_at < ?");
      params.push(opts.before);
    }
    const conds = [where.replace(/^WHERE\s+/, ""), ...extra].filter(Boolean);
    const row = this.db
      .query(
        `SELECT MIN(updated_at) AS t FROM memories${conds.length ? ` WHERE ${conds.join(" AND ")}` : ""}`,
      )
      .get(...params) as { t: number | null } | null;
    return row?.t ?? null;
  }

  /**
   * search 与 countMatches 共用的 WHERE 片段。
   *
   * 抽出来的唯一目的：让「返回哪几条」与「共命中几条」永远走同一套过滤条件
   * （scope / projectId / kind / includeArchived），否则两个数字口径会漂移。
   * 空查询（buildMatchExpr 返回 null）视为无命中。
   */
  private matchClause(
    rawQuery: string,
    opts: ListOpts,
  ): { expr: string; extra: string; params: SQLQueryBindings[] } | null {
    const expr = buildMatchExpr(rawQuery);
    if (!expr) return null;
    const { where, params } = this.buildFilter({
      ...opts,
      includeArchived: opts.includeArchived ?? false,
    });
    const extra = where ? `AND ${where.replace(/^WHERE\s+/, "")}` : "";
    return { expr, extra, params };
  }

  /**
   * 子串回退的 WHERE 片段（见 searchBySubstring 的说明）。
   * 与 matchClause 共用 buildFilter，保证过滤条件与 FTS 路径完全一致。
   */
  private substringClause(
    rawQuery: string,
    opts: ListOpts,
  ): { extra: string; params: SQLQueryBindings[]; like: string } | null {
    const needle = rawQuery.trim();
    // 空查询与 FTS 路径同口径：视为无命中（不做全表扫描）
    if (!needle) return null;
    const { where, params } = this.buildFilter({
      ...opts,
      includeArchived: opts.includeArchived ?? false,
    });
    const extra = where ? `AND ${where.replace(/^WHERE\s+/, "")}` : "";
    // LIKE 元字符转义：SQLite 默认把 % / _ 当通配符，查询 "100%" 会命中一切
    const like = `%${needle.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    return { extra, params, like };
  }

  /**
   * 子串回退：FTS 零命中时改走 LIKE 子串匹配。
   *
   * 为什么需要：写入索引的正文经 bigram() 切成**相邻二元组**，单个汉字只作为二元组的
   * 一部分存在（「示例」→ `示例`），因此「示」这类单字查询的 token 永远比不中——
   * 实测单字查询 FTS 命中 0，而库里有正文含该字。UI 走本地 includes 时被掩盖，
   * 切到服务端检索后暴露。
   *
   * 为什么不在写侧补 unigram：那要重建存量 memories_fts（迁移），而查询侧回退零迁移。
   * 触发条件刻意收紧为「FTS 零命中」——有 FTS 命中时绝不回退，否则「示例」会退化成
   * 把所有只含「示」的条目也捞出来，相关性被稀释。
   *
   * 打分：子串命中之间无强弱之分，bm25 分量统一取 1，仍叠加时间衰减与 kind 权重，
   * 与 FTS 路径的排序语义保持一致。
   */
  private searchBySubstring(
    rawQuery: string,
    opts: SearchOpts,
    w: { bm25: number; time: number; kind: number },
    halfLife: number,
    now: number,
  ): SearchHit[] {
    const clause = this.substringClause(rawQuery, opts);
    if (!clause) return [];
    const rows = this.db
      .query(
        `SELECT m.*
           FROM memories m
          WHERE (m.content LIKE ? ESCAPE '\\'
                 OR m.title LIKE ? ESCAPE '\\'
                 OR m.tags LIKE ? ESCAPE '\\') ${clause.extra}
          ORDER BY m.updated_at DESC
          LIMIT ${CANDIDATE_LIMIT}`,
      )
      .all(clause.like, clause.like, clause.like, ...clause.params) as RawRow[];
    if (rows.length === 0) return [];

    const hits: SearchHit[] = rows.map((r) => {
      const row = toRow(r);
      const ageDays = Math.max(0, (now - row.updatedAt) / 86_400_000);
      const timeScore = Math.exp(-ageDays / halfLife);
      return {
        ...row,
        snippet: makeSnippet(row.content, rawQuery),
        score: w.bm25 * 1 + w.time * timeScore + w.kind * KIND_BOOST[row.kind],
      };
    });
    hits.sort((a, b) => b.score - a.score);
    return this.touchHits(hits.slice(0, opts.limit ?? 10));
  }

  /** 命中即刷新热度信号（供后续「热度」排序用） */
  private touchHits(hits: SearchHit[]): SearchHit[] {
    const touched = Date.now();
    for (const h of hits) {
      this.db.run(
        "UPDATE memories SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?",
        [touched, h.id],
      );
    }
    return hits;
  }

  /**
   * 与 search 同口径的真实命中总数。
   *
   * 关键：**不**加 LIMIT —— 既不受调用方的 limit 影响，也不受检索候选
   * 硬截断 CANDIDATE_LIMIT（50）影响。memory_search 的 totalMatched 用它，
   * 从而回答「一共看到多少 / 还有多少没看到」而不是「这一页有几条」。
   */
  countMatches(rawQuery: string, opts: ListOpts = {}): number {
    const clause = this.matchClause(rawQuery, opts);
    if (!clause) return 0;
    const row = this.db
      .query(
        `SELECT COUNT(*) AS n
           FROM memories_fts
           JOIN memories m ON m.id = memories_fts.memory_id
          WHERE memories_fts MATCH ? ${clause.extra}`,
      )
      .get(clause.expr, ...clause.params) as { n: number } | null;
    const n = row?.n ?? 0;
    if (n > 0) return n;

    // 与 search 同源的回退：FTS 零命中时按子串口径统计，否则「命中了却显示共 0 条」
    const sub = this.substringClause(rawQuery, opts);
    if (!sub) return 0;
    const row2 = this.db
      .query(
        `SELECT COUNT(*) AS n
           FROM memories m
          WHERE (m.content LIKE ? ESCAPE '\\'
                 OR m.title LIKE ? ESCAPE '\\'
                 OR m.tags LIKE ? ESCAPE '\\') ${sub.extra}`,
      )
      .get(sub.like, sub.like, sub.like, ...sub.params) as { n: number } | null;
    return row2?.n ?? 0;
  }

  /** BM25 检索 + 时间衰减 + kind 加权综合排序（规格 §5） */
  search(rawQuery: string, opts: SearchOpts = {}): SearchHit[] {
    const clause = this.matchClause(rawQuery, opts);
    if (!clause) return [];

    const w = { bm25: 1.0, time: 0.5, kind: 0.3, ...(opts.weights ?? {}) };
    const halfLife = opts.halfLifeDays ?? 30;
    const now = opts.now ?? Date.now();

    const rows = this.db
      .query(
        `SELECT m.*, bm25(memories_fts) AS score
           FROM memories_fts
           JOIN memories m ON m.id = memories_fts.memory_id
          WHERE memories_fts MATCH ? ${clause.extra}
          LIMIT ${CANDIDATE_LIMIT}`,
      )
      .all(clause.expr, ...clause.params) as Array<RawRow & { score: number }>;

    if (rows.length === 0) {
      // 索引对单字等查询天然无 token 可比（bigram 取舍），零命中时回退子串匹配
      return this.searchBySubstring(rawQuery, opts, w, halfLife, now);
    }

    // bm25 返回负值（越小越相关）；同批次内 min-max 归一到 [0,1]
    const scores = rows.map((r) => r.score);
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const span = max - min;

    const hits: SearchHit[] = rows.map((r) => {
      const norm = span === 0 ? 1 : (max - r.score) / span;
      const row = toRow(r);
      const ageDays = Math.max(0, (now - row.updatedAt) / 86_400_000);
      const timeScore = Math.exp(-ageDays / halfLife);
      return {
        ...row,
        snippet: makeSnippet(row.content, rawQuery),
        score:
          w.bm25 * norm + w.time * timeScore + w.kind * KIND_BOOST[row.kind],
      };
    });

    hits.sort((a, b) => b.score - a.score);
    return this.touchHits(hits.slice(0, opts.limit ?? 10));
  }

  private buildFilter(opts: ListOpts): {
    where: string;
    params: SQLQueryBindings[];
  } {
    const clauses: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (opts.archivedOnly) clauses.push("archived = 1");
    else if (!opts.includeArchived) clauses.push("archived = 0");
    if (opts.kind) {
      clauses.push("kind = ?");
      params.push(opts.kind);
    }
    if (opts.scope) {
      clauses.push("scope = ?");
      params.push(opts.scope);
    }
    // undefined / null / 空串都不加条件（空串不是合法的 projectId）
    if (opts.projectId) {
      clauses.push("project_id = ?");
      params.push(opts.projectId);
    }
    // 时间范围（含端点）。列名只从白名单常量里取，不拼接外部输入。
    const timeCol = opts.timeField === "created" ? "created_at" : "updated_at";
    if (typeof opts.since === "number") {
      clauses.push(`${timeCol} >= ?`);
      params.push(opts.since);
    }
    if (typeof opts.until === "number") {
      clauses.push(`${timeCol} <= ?`);
      params.push(opts.until);
    }
    return {
      where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "",
      params,
    };
  }

  /** FTS 同步：先删旧行再插新行（内容可能变化，不能只 update） */
  private syncFts(row: MemoryRow): void {
    const body = bigram(`${row.title} ${row.content} ${row.tags}`);
    this.db.run("DELETE FROM memories_fts WHERE memory_id = ?", [row.id]);
    this.db.run("INSERT INTO memories_fts(body, memory_id) VALUES (?, ?)", [
      body,
      row.id,
    ]);
  }
}
