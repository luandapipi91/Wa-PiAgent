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
  id: string; kind: string; target: string; scope: string; project_id: string | null;
  content: string; title: string; tags: string; source: string;
  created_at: number; updated_at: number; last_used_at: number | null;
  use_count: number; archived: number; archived_at: number | null;
}

function toRow(r: RawRow): MemoryRow {
  return {
    id: r.id, kind: r.kind as MemoryKind, target: r.target as MemoryTarget,
    scope: r.scope as MemoryScope, projectId: r.project_id,
    content: r.content, title: r.title, tags: r.tags, source: r.source,
    createdAt: r.created_at, updatedAt: r.updated_at,
    lastUsedAt: r.last_used_at, useCount: r.use_count,
    archived: r.archived, archivedAt: r.archived_at,
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
      [id, input.kind, input.target, input.scope, input.projectId ?? null,
       input.content, title, input.tags ?? "", input.source, now, now],
    );
    const row = this.getById(id)!;
    this.syncFts(row);
    return row;
  }

  getById(id: string): MemoryRow | null {
    const r = this.db.query("SELECT * FROM memories WHERE id = ?").get(id) as RawRow | null;
    return r ? toRow(r) : null;
  }

  /** 按内容子串查找（memory_replace/remove 无 id 时的兼容路径） */
  findBySubstring(text: string, opts: ListOpts = {}): MemoryRow[] {
    const trimmed = text.trim();
    if (!trimmed) return [];
    return this.list({ ...opts, includeArchived: opts.includeArchived ?? false })
      .filter((r) => r.content.includes(trimmed));
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
    const res = this.db.run(
      "UPDATE memories SET archived = 0, archived_at = NULL, updated_at = ? WHERE id = ? AND archived = 1",
      [Date.now(), id],
    );
    return res.changes > 0;
  }

  /** 彻底删除归档条目（与 remove 同义，保留给 UI 的 purge 语义） */
  purge(id: string): boolean {
    return this.remove(id);
  }

  list(opts: ListOpts = {}): MemoryRow[] {
    const { where, params } = this.buildFilter(opts);
    const rows = this.db
      .query(`SELECT * FROM memories ${where} ORDER BY updated_at DESC`)
      .all(...params) as RawRow[];
    return rows.map(toRow);
  }

  counts(opts: ListOpts = {}): Record<MemoryKind, number> {
    const { where, params } = this.buildFilter(opts);
    const rows = this.db
      .query(`SELECT kind, COUNT(*) AS n FROM memories ${where} GROUP BY kind`)
      .all(...params) as Array<{ kind: string; n: number }>;
    const out: Record<MemoryKind, number> = { profile: 0, knowledge: 0, execution: 0 };
    for (const r of rows) {
      if (r.kind in out) out[r.kind as MemoryKind] = r.n;
    }
    return out;
  }

  /** BM25 检索 + 时间衰减 + kind 加权综合排序（规格 §5） */
  search(rawQuery: string, opts: SearchOpts = {}): SearchHit[] {
    const expr = buildMatchExpr(rawQuery);
    if (!expr) return [];

    const w = { bm25: 1.0, time: 0.5, kind: 0.3, ...(opts.weights ?? {}) };
    const halfLife = opts.halfLifeDays ?? 30;
    const now = opts.now ?? Date.now();

    const { where, params } = this.buildFilter({
      ...opts,
      includeArchived: opts.includeArchived ?? false,
    });
    const extra = where ? `AND ${where.replace(/^WHERE\s+/, "")}` : "";

    const rows = this.db
      .query(
        `SELECT m.*, bm25(memories_fts) AS score
           FROM memories_fts
           JOIN memories m ON m.id = memories_fts.memory_id
          WHERE memories_fts MATCH ? ${extra}
          LIMIT ${CANDIDATE_LIMIT}`,
      )
      .all(expr, ...params) as Array<RawRow & { score: number }>;

    if (rows.length === 0) return [];

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
    const limited = hits.slice(0, opts.limit ?? 10);

    // 命中即刷新热度信号（供后续“热度”排序用）
    const touched = Date.now();
    for (const h of limited) {
      this.db.run(
        "UPDATE memories SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?",
        [touched, h.id],
      );
    }
    return limited;
  }

  private buildFilter(opts: ListOpts): { where: string; params: SQLQueryBindings[] } {
    const clauses: string[] = [];
    const params: SQLQueryBindings[] = [];
    if (!opts.includeArchived) clauses.push("archived = 0");
    if (opts.kind) { clauses.push("kind = ?"); params.push(opts.kind); }
    if (opts.scope) { clauses.push("scope = ?"); params.push(opts.scope); }
    // undefined / null / 空串都不加条件（空串不是合法的 projectId）
    if (opts.projectId) {
      clauses.push("project_id = ?");
      params.push(opts.projectId);
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
    this.db.run("INSERT INTO memories_fts(body, memory_id) VALUES (?, ?)", [body, row.id]);
  }
}
