// packages/kernel/src/memory/tools.ts
// 记忆工具集（五个）。取代原 amaster-memory.ts 的 createAgentMemoryTools。
//
// 约定：
// - 未传 kind 时按 target+scope 路由（user+global → profile，其余 knowledge）
// - 未传 scope 时按 target 路由（user → global，memory → project）
// - 显式要求 project 范围时必须先过 requireProjectId 校验（缺 projectId 即拒绝，
//   不得降级为「不加项目过滤」而跨项目读改删）
// - 写入前做注入防护校验；返回错误对象而不抛异常（与旧行为一致）
import { Type } from "typebox";
import {
  MEM_ADD_DESC,
  MEM_ADD_SNIPPET,
  MEM_REPLACE_DESC,
  MEM_REPLACE_SNIPPET,
  MEM_REMOVE_DESC,
  MEM_REMOVE_SNIPPET,
  MEM_READ_DESC,
  MEM_READ_SNIPPET,
  MEM_SEARCH_DESC,
  MEM_SEARCH_SNIPPET,
  MemoryTargetSchema,
  MemoryScopeSchema,
  MemoryKindSchema,
  MemorySearchParamsSchema,
} from "@wa-pi/shared";
import type {
  ListOpts,
  MemoryDao,
  MemoryKind,
  MemoryRow,
  MemoryScope,
  MemoryTarget,
} from "./dao";
import { firstThreatMessage } from "./threat-patterns";

export interface ToolDefinition {
  name: string;
  label?: string;
  description: string;
  parameters: unknown;
  promptSnippet?: string;
  promptGuidelines?: string[];
  execute: (
    toolCallId: string,
    params: any,
    signal?: AbortSignal,
  ) => Promise<unknown>;
}

export interface MemoryToolContext {
  dao: MemoryDao;
  /** 项目标识（cwd basename）；无项目上下文时为 null */
  projectId: string | null;
}

export function resolveScope(
  target: MemoryTarget,
  scope: unknown,
): MemoryScope {
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

export type ProjectIdCheck =
  | { ok: true; projectId: string | null }
  | { ok: false; error: string };

/**
 * 项目上下文校验（add / read / search / replace / remove 共用的唯一入口）。
 *
 * 规则：显式要求 project 范围时必须有项目上下文，否则**拒绝执行**。
 * 绝不能把缺失的 projectId 降级成「不加项目过滤」—— buildFilter 对 null 的
 * 语义是「不加条件」，降级即等于跨所有项目读改删。
 * - scope === "project"：必须有非空 ctx.projectId，否则 ok:false
 * - scope === "global" / 未传 scope：合法，projectId 为 null（不按项目过滤）
 *   （未传 scope 的 read/search 是跨域检索，规格允许）
 *
 * 返回值用判别式联合而非简报建议的 `string | null`：null 无法区分「合法但无项目」
 * 与「非法」，调用方只要漏写一次额外判断就会静默重现 fail-open。
 */
export function requireProjectId(
  ctx: MemoryToolContext,
  scope: MemoryScope | undefined,
): ProjectIdCheck {
  if (scope !== "project") return { ok: true, projectId: null };
  if (!ctx.projectId) {
    return { ok: false, error: "项目记忆需要项目上下文（projectId）" };
  }
  return { ok: true, projectId: ctx.projectId };
}

/**
 * 条目归属校验（id 变更路径的唯一入口）。
 *
 * 按 id 定位时，声明什么 scope 由**行自身**决定，不能信调用方：不传 scope 的
 * memory_search 是跨域检索（规格允许，会返回别项目条目的 id），若这里不校验
 * 归属，就能借 memory_search 拿到的 id 改掉/删掉**别的项目**的记忆。
 * - 行 scope === "project"：先过 requireProjectId（缺上下文即拒绝），
 *   再要求 row.projectId 与 ctx.projectId **严格相等**（大小写不同即不同项目，
 *   与 DAO 的 `project_id = ?` 精确匹配口径一致；row.projectId 为 NULL 的迁移
 *   遗留条目同样不匹配 → 拒绝）
 * - 行 scope === "global"：全局记忆本就跨项目共享，任何会话都可读改，不额外校验
 */
export function requireEntryOwnership(
  ctx: MemoryToolContext,
  row: MemoryRow,
): ProjectIdCheck {
  if (row.scope !== "project") return { ok: true, projectId: null };
  const check = requireProjectId(ctx, row.scope);
  if (!check.ok) return check;
  if (row.projectId !== check.projectId) {
    return {
      ok: false,
      error: `该条目属于另一个项目（projectId ${row.projectId ?? "无"}），不能在项目 ${check.projectId} 下修改`,
    };
  }
  return check;
}

const jsonResult = (v: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: typeof v === "string" ? v : JSON.stringify(v, null, 2),
    },
  ],
  details: undefined,
});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * 解析 memory_search 的 since/until 边界，返回毫秒时间戳；识别不了的值返回 undefined
 * （= 不设该边界，而不是报错——与其余参数「非法即当没传」的惯例一致）。
 * - 数字：按毫秒时间戳
 * - "YYYY-MM-DD"：按本地时区；endOfDay 时补到 23:59:59.999，让 until 含当天
 * - 其它字符串：走 Date.parse（带时间的 ISO 串等）
 */
export function parseTimeBound(
  raw: unknown,
  endOfDay = false,
): number | undefined {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== "string") return undefined;
  const s = raw.trim();
  if (!s) return undefined;
  // 纯数字串（≥10 位）按毫秒时间戳，避免被 Date.parse 当成年份
  if (/^\d{10,}$/.test(s)) return Number(s);
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (dateOnly) {
    const y = +dateOnly[1];
    const mo = +dateOnly[2];
    const d = +dateOnly[3];
    const dt = endOfDay
      ? new Date(y, mo - 1, d, 23, 59, 59, 999)
      : new Date(y, mo - 1, d);
    // Date 会把 2026-13-45 这类非法日期静默滚动成别的日子，必须回读校验
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d)
      return undefined;
    return dt.getTime();
  }
  const parsed = Date.parse(s);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * 回灌模型前的注入净化。
 *
 * 快照路径（snapshot.ts）已对注入系统提示词的条目做过防护；检索/读取结果是同一批数据的
 * 另一条回灌通道，若不过滤就等于把刚移植的防护整个旁路掉——数据库被外部/存量污染时，
 * 同一条目在快照里是占位符，而 search/read 返回的仍是原载荷。
 */
function sanitize(text: string): string {
  return firstThreatMessage(text, "strict") ? "[BLOCKED]" : text;
}

function toEntryJson(r: MemoryRow) {
  return {
    id: r.id,
    title: sanitize(r.title),
    content: sanitize(r.content),
    kind: r.kind,
    scope: r.scope,
    projectId: r.projectId,
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
  const target: MemoryTarget =
    str(params.target) === "user" ? "user" : "memory";
  const scope = resolveScope(target, params.scope);

  // scope 层面的两道校验：
  // 1) 无 id —— 只能按 scope + oldText 过滤匹配，匹配范围由 scope 决定
  // 2) 有 id 但调用方显式声明了 scope="project" —— 声明必须自洽
  const guardScope: MemoryScope | undefined =
    id && params.scope !== "project" ? undefined : scope;
  const check = requireProjectId(ctx, guardScope);
  if (!check.ok)
    return {
      ok: false,
      result: jsonResult({ success: false, error: check.error }),
    };

  if (id) {
    const row = ctx.dao.getById(id);
    if (!row)
      return {
        ok: false,
        result: jsonResult({
          success: false,
          error: `No entry matched id '${id}'.`,
        }),
      };
    // 归属校验：scope 未声明时上面那道校验放行，由这一道按行自身的归属把关
    const ownership = requireEntryOwnership(ctx, row);
    if (!ownership.ok) {
      return {
        ok: false,
        result: jsonResult({ success: false, error: ownership.error }),
      };
    }
    return { ok: true, rows: [row] };
  }

  const oldText = str(params.oldText).trim();
  if (!oldText) {
    return {
      ok: false,
      result: jsonResult({
        success: false,
        error: "Provide either id or oldText.",
      }),
    };
  }
  const rows = ctx.dao.findBySubstring(oldText, {
    scope,
    projectId: check.projectId,
  });
  if (rows.length === 0) {
    return {
      ok: false,
      result: jsonResult({
        success: false,
        error: `No entry matched '${oldText}'.`,
      }),
    };
  }
  if (rows.length > 1) {
    return {
      ok: false,
      result: jsonResult({
        success: false,
        error: `Multiple entries matched '${oldText}'. Be more specific or pass id.`,
        matches: rows.map((r) => ({ id: r.id, title: sanitize(r.title) })),
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
        title: Type.Optional(
          Type.String({
            description:
              "Optional short title; derived from content when omitted.",
          }),
        ),
        tags: Type.Optional(
          Type.Array(Type.String(), {
            description: "Optional keywords for retrieval.",
          }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const target: MemoryTarget =
          str(params.target) === "user" ? "user" : "memory";
        const scope = resolveScope(target, params.scope);
        const kind = resolveKind(target, scope, params.kind);
        const content = str(params.content);
        if (!content.trim())
          return jsonResult({
            success: false,
            error: "Content cannot be empty.",
          });

        // title 与 content 同样会回灌模型上下文（search 结果 / read 条目 / 快照），
        // 必须同规则校验，否则写入侧只扫 content 就能用 title 夹带载荷绕过防护。
        const title = str(params.title);
        const threat =
          firstThreatMessage(content, "strict") ??
          (title ? firstThreatMessage(title, "strict") : null);
        if (threat) return jsonResult({ success: false, error: threat });

        const check = requireProjectId(ctx, scope);
        if (!check.ok)
          return jsonResult({ success: false, error: check.error });
        const projectId = check.projectId;

        const tags = Array.isArray(params.tags)
          ? params.tags.filter((t) => typeof t === "string").join(",")
          : "";
        const row = ctx.dao.insert({
          kind,
          target,
          scope,
          projectId,
          content,
          source: "agent",
          title: title || undefined,
          tags,
        });
        return jsonResult({
          success: true,
          id: row.id,
          kind: row.kind,
          scope: row.scope,
          totals: ctx.dao.counts({ scope, projectId }),
        });
      },
    },
    {
      name: "memory_search",
      label: "Memory",
      description: MEM_SEARCH_DESC,
      promptSnippet: MEM_SEARCH_SNIPPET,
      parameters: MemorySearchParamsSchema,
      async execute(_id: string, params: Record<string, unknown>) {
        const scope =
          params.scope === "global" || params.scope === "project"
            ? (params.scope as MemoryScope)
            : undefined;
        const check = requireProjectId(ctx, scope);
        if (!check.ok)
          return jsonResult({ success: false, error: check.error });

        const query = str(params.query);
        const kind =
          params.kind === "execution" || params.kind === "knowledge"
            ? params.kind
            : undefined;
        // search 与 countMatches 必须拿到同一份过滤条件，否则 totalMatched 与 results 口径不一
        const filter: ListOpts = {
          scope,
          projectId: check.projectId ?? undefined,
          kind,
          includeArchived: params.includeArchived === true,
          since: parseTimeBound(params.since),
          until: parseTimeBound(params.until, true),
          timeField: params.timeField === "created" ? "created" : "updated",
        };
        const hits = ctx.dao.search(query, {
          ...filter,
          limit: typeof params.limit === "number" ? params.limit : 10,
        });
        return jsonResult({
          results: hits.map((h) => ({
            id: h.id,
            title: sanitize(h.title),
            snippet: sanitize(h.snippet),
            kind: h.kind,
            scope: h.scope,
            projectId: h.projectId,
            updatedAt: new Date(h.updatedAt).toISOString(),
            score: Number(h.score.toFixed(4)),
            archived: h.archived === 1,
          })),
          // 真实命中总数（与 results 同过滤条件，但不受 limit / CANDIDATE_LIMIT 截断）
          totalMatched: ctx.dao.countMatches(query, filter),
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
        limit: Type.Optional(
          Type.Number({ description: "Max entries (default 50)." }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const scope =
          params.scope === "global" || params.scope === "project"
            ? (params.scope as MemoryScope)
            : undefined;
        const check = requireProjectId(ctx, scope);
        if (!check.ok)
          return jsonResult({ success: false, error: check.error });
        const projectId = check.projectId ?? undefined;

        const target =
          str(params.target) === "user"
            ? "user"
            : str(params.target) === "memory"
              ? "memory"
              : undefined;
        const kind =
          params.kind === "execution" || params.kind === "knowledge"
            ? params.kind
            : undefined;
        const limit = typeof params.limit === "number" ? params.limit : 50;

        const rows = ctx.dao
          .list({ scope, projectId, kind })
          .filter((r) => !target || r.target === target)
          .slice(0, limit);
        return jsonResult({
          entries: rows.map(toEntryJson),
          counts: ctx.dao.counts({ scope, projectId }),
        });
      },
    },
    {
      name: "memory_replace",
      label: "Memory",
      description: MEM_REPLACE_DESC,
      promptSnippet: MEM_REPLACE_SNIPPET,
      parameters: Type.Object({
        id: Type.Optional(
          Type.String({
            description:
              "Entry id from memory_search / memory_read (preferred).",
          }),
        ),
        target: Type.Optional(MemoryTargetSchema),
        scope: Type.Optional(MemoryScopeSchema),
        oldText: Type.Optional(
          Type.String({
            description:
              "Substring uniquely identifying the entry when id is unknown.",
          }),
        ),
        newContent: Type.String({
          description: "The replacement entry content.",
        }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        const resolved = resolveTargets(ctx, params);
        if (!resolved.ok) return resolved.result;
        const newContent = str(params.newContent);
        if (!newContent.trim())
          return jsonResult({
            success: false,
            error: "Content cannot be empty.",
          });
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
        id: Type.Optional(
          Type.String({ description: "Entry id (preferred)." }),
        ),
        target: Type.Optional(MemoryTargetSchema),
        scope: Type.Optional(MemoryScopeSchema),
        oldText: Type.Optional(
          Type.String({
            description:
              "Substring uniquely identifying the entry when id is unknown.",
          }),
        ),
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
