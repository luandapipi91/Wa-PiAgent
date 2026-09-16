// packages/kernel/src/memory/tools.ts
// 记忆工具集（五个）。取代原 amaster-memory.ts 的 createAgentMemoryTools。
//
// 约定：
// - 未传 kind 时按 target+scope 路由（user+global → profile，其余 knowledge）
// - 未传 scope 时按 target 路由（user → global，memory → project）
// - 写入前做注入防护校验；返回错误对象而不抛异常（与旧行为一致）
import { Type } from "typebox";
import {
  MEM_ADD_DESC, MEM_ADD_SNIPPET, MEM_REPLACE_DESC, MEM_REPLACE_SNIPPET,
  MEM_REMOVE_DESC, MEM_REMOVE_SNIPPET, MEM_READ_DESC, MEM_READ_SNIPPET,
  MEM_SEARCH_DESC, MEM_SEARCH_SNIPPET, MemoryTargetSchema, MemoryScopeSchema,
  MemoryKindSchema,
} from "@wa-pi/shared";
import type { MemoryDao, MemoryKind, MemoryRow, MemoryScope, MemoryTarget } from "./dao";
import { firstThreatMessage } from "./threat-patterns";

export interface ToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute: (toolCallId: string, params: any, signal?: AbortSignal) => Promise<unknown>;
}

export interface MemoryToolContext {
  dao: MemoryDao;
  /** 记忆库所在数据目录（调用方持有；工具层不直接读写文件） */
  waPiDir?: string;
  /** 项目标识（cwd basename）；无项目上下文时为 null */
  projectId: string | null;
}

export function resolveScope(target: MemoryTarget, scope: unknown): MemoryScope {
  if (scope === "global" || scope === "project") return scope;
  return target === "user" ? "global" : "project";
}

export function resolveKind(
  target: MemoryTarget,
  scope: MemoryScope,
  explicit: unknown,
): MemoryKind {
  if (explicit === "execution") return "execution";
  if (explicit === "knowledge") return "knowledge";
  return target === "user" && scope === "global" ? "profile" : "knowledge";
}

const jsonResult = (v: unknown) => ({
  content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }],
  details: undefined,
});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

function toEntryJson(r: MemoryRow) {
  return {
    id: r.id, title: r.title, content: r.content, kind: r.kind,
    scope: r.scope, projectId: r.projectId,
    createdAt: new Date(r.createdAt).toISOString(),
    updatedAt: new Date(r.updatedAt).toISOString(),
    archived: r.archived === 1,
  };
}

/** 解析变更目标：id 优先；无 id 时按 target/scope + oldText 子串匹配 */
function resolveTargets(
  ctx: MemoryToolContext,
  params: Record<string, unknown>,
): { ok: true; rows: MemoryRow[] } | { ok: false; result: unknown } {
  const id = str(params.id);
  if (id) {
    const row = ctx.dao.getById(id);
    if (!row) return { ok: false, result: jsonResult({ success: false, error: `No entry matched id '${id}'.` }) };
    return { ok: true, rows: [row] };
  }
  const target: MemoryTarget = str(params.target) === "user" ? "user" : "memory";
  const scope = resolveScope(target, params.scope);
  const oldText = str(params.oldText).trim();
  if (!oldText) {
    return { ok: false, result: jsonResult({ success: false, error: "Provide either id or oldText." }) };
  }
  const rows = ctx.dao.findBySubstring(oldText, {
    scope,
    projectId: scope === "project" ? ctx.projectId : null,
  });
  if (rows.length === 0) {
    return { ok: false, result: jsonResult({ success: false, error: `No entry matched '${oldText}'.` }) };
  }
  if (rows.length > 1) {
    return {
      ok: false,
      result: jsonResult({
        success: false,
        error: `Multiple entries matched '${oldText}'. Be more specific or pass id.`,
        matches: rows.map((r) => ({ id: r.id, title: r.title })),
      }),
    };
  }
  return { ok: true, rows };
}

export function createMemoryTools(ctx: MemoryToolContext): ToolDefinition[] {
  return [
    {
      name: "memory_add",
      label: "Memory",
      description: MEM_ADD_DESC,
      promptSnippet: MEM_ADD_SNIPPET,
      parameters: Type.Object({
        target: MemoryTargetSchema,
        scope: Type.Optional(MemoryScopeSchema),
        content: Type.String({ description: "The entry content to append." }),
        kind: Type.Optional(MemoryKindSchema),
        title: Type.Optional(Type.String({ description: "Optional short title; derived from content when omitted." })),
        tags: Type.Optional(Type.Array(Type.String(), { description: "Optional keywords for retrieval." })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const target: MemoryTarget = str(params.target) === "user" ? "user" : "memory";
        const scope = resolveScope(target, params.scope);
        const kind = resolveKind(target, scope, params.kind);
        const content = str(params.content);
        if (!content.trim()) return jsonResult({ success: false, error: "Content cannot be empty." });

        const threat = firstThreatMessage(content, "strict");
        if (threat) return jsonResult({ success: false, error: threat });

        const projectId = scope === "project" ? ctx.projectId : null;
        if (scope === "project" && !projectId) {
          return jsonResult({ success: false, error: "项目记忆需要项目上下文（projectId）" });
        }

        const tags = Array.isArray(params.tags) ? params.tags.filter((t) => typeof t === "string").join(",") : "";
        const row = ctx.dao.insert({
          kind, target, scope, projectId, content,
          source: "agent", title: str(params.title) || undefined, tags,
        });
        return jsonResult({
          success: true, id: row.id, kind: row.kind, scope: row.scope,
          totals: ctx.dao.counts({ scope, projectId }),
        });
      },
    },
    {
      name: "memory_search",
      label: "Memory",
      description: MEM_SEARCH_DESC,
      promptSnippet: MEM_SEARCH_SNIPPET,
      parameters: Type.Object({
        query: Type.String({ description: "Keywords to search for (Chinese or English)." }),
        scope: Type.Optional(MemoryScopeSchema),
        kind: Type.Optional(MemoryKindSchema),
        limit: Type.Optional(Type.Number({ description: "Max results (default 10)." })),
        includeArchived: Type.Optional(Type.Boolean({ description: "Include archived entries (default false)." })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const scope = (params.scope === "global" || params.scope === "project")
          ? (params.scope as MemoryScope)
          : undefined;
        const hits = ctx.dao.search(str(params.query), {
          scope,
          projectId: scope === "project" ? ctx.projectId : undefined,
          kind: (params.kind === "execution" || params.kind === "knowledge") ? params.kind : undefined,
          includeArchived: params.includeArchived === true,
          limit: typeof params.limit === "number" ? params.limit : 10,
        });
        return jsonResult({
          results: hits.map((h) => ({
            id: h.id, title: h.title, snippet: h.snippet, kind: h.kind,
            scope: h.scope, projectId: h.projectId,
            updatedAt: new Date(h.updatedAt).toISOString(),
            score: Number(h.score.toFixed(4)), archived: h.archived === 1,
          })),
          totalMatched: hits.length,
        });
      },
    },
    {
      name: "memory_read",
      label: "Memory",
      description: MEM_READ_DESC,
      promptSnippet: MEM_READ_SNIPPET,
      parameters: Type.Object({
        target: Type.Optional(MemoryTargetSchema),
        scope: Type.Optional(MemoryScopeSchema),
        kind: Type.Optional(MemoryKindSchema),
        limit: Type.Optional(Type.Number({ description: "Max entries (default 50)." })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const scope = (params.scope === "global" || params.scope === "project")
          ? (params.scope as MemoryScope)
          : undefined;
        const target = str(params.target) === "user" ? "user"
          : str(params.target) === "memory" ? "memory" : undefined;
        const kind = (params.kind === "execution" || params.kind === "knowledge") ? params.kind : undefined;
        const limit = typeof params.limit === "number" ? params.limit : 50;

        const rows = ctx.dao
          .list({ scope, projectId: scope === "project" ? ctx.projectId : undefined, kind })
          .filter((r) => !target || r.target === target)
          .slice(0, limit);
        return jsonResult({
          entries: rows.map(toEntryJson),
          counts: ctx.dao.counts({ scope, projectId: scope === "project" ? ctx.projectId : undefined }),
        });
      },
    },
    {
      name: "memory_replace",
      label: "Memory",
      description: MEM_REPLACE_DESC,
      promptSnippet: MEM_REPLACE_SNIPPET,
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: "Entry id from memory_search / memory_read (preferred)." })),
        target: Type.Optional(MemoryTargetSchema),
        scope: Type.Optional(MemoryScopeSchema),
        oldText: Type.Optional(Type.String({ description: "Substring uniquely identifying the entry when id is unknown." })),
        newContent: Type.String({ description: "The replacement entry content." }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const resolved = resolveTargets(ctx, params);
        if (!resolved.ok) return resolved.result;
        const newContent = str(params.newContent);
        if (!newContent.trim()) return jsonResult({ success: false, error: "Content cannot be empty." });
        const threat = firstThreatMessage(newContent, "strict");
        if (threat) return jsonResult({ success: false, error: threat });
        const ok = ctx.dao.updateContent(resolved.rows[0].id, newContent);
        return jsonResult({ success: ok, id: resolved.rows[0].id });
      },
    },
    {
      name: "memory_remove",
      label: "Memory",
      description: MEM_REMOVE_DESC,
      promptSnippet: MEM_REMOVE_SNIPPET,
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: "Entry id (preferred)." })),
        target: Type.Optional(MemoryTargetSchema),
        scope: Type.Optional(MemoryScopeSchema),
        oldText: Type.Optional(Type.String({ description: "Substring uniquely identifying the entry when id is unknown." })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const resolved = resolveTargets(ctx, params);
        if (!resolved.ok) return resolved.result;
        const ok = ctx.dao.remove(resolved.rows[0].id);
        return jsonResult({ success: ok, id: resolved.rows[0].id });
      },
    },
  ] as unknown as ToolDefinition[];
}
