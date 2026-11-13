// tool-schemas.ts —— 宿主工具的共享文案与 TypeBox Schema
//
// 本文件是 WaPi 7 个宿主工具描述和参数 schema 的唯一真源。
// Kernel 侧（delegate-tool / ask-tool / amaster-memory）和
// Pi bridge 扩展（wa-pi-bridge.ts）均从此处引用，消除文案重复。
//
// 依赖：仅 typebox（Pi 进程和 WaPi kernel 均可用）。

import { Type } from "typebox";
import type { KbSearchMode, KbSearchProfile } from "./types";

// =========================================================================
// ask_user_question
// =========================================================================

export const ASK_DESCRIPTION =
  "向用户提出 1-4 个结构化澄清问题（每问 2-4 个选项），代替瞎猜。每个问题可单选或多选；" +
  "用户可填「其他」自由文本或取消。返回 details.answers（含 kind: option|custom|multi）或 cancelled。";

export const ASK_PROMPT_GUIDELINES = [
  "当存在会显著改变实现的歧义、且不值得自己合理假设时再用；一次问最少必要的问题；",
  "选项文案简洁，给出取舍说明；不要用于确认显而易见的事。",
];

export const AskParamsSchema = Type.Object({
  questions: Type.Array(
    Type.Object({
      question: Type.String({ description: "完整问题文本，以 ? 结尾" }),
      header: Type.String({ description: "chip 标签文字，≤16 字符" }),
      multiSelect: Type.Optional(
        Type.Boolean({ description: "是否多选，默认 false" }),
      ),
      options: Type.Array(
        Type.Object({
          label: Type.String({ description: "1-5 词，≤60 字符" }),
          description: Type.String({ description: "解释该选项/取舍" }),
          preview: Type.Optional(
            Type.String({ description: "可选 markdown，随选项展示" }),
          ),
        }),
        { minItems: 2, maxItems: 4 },
      ),
    }),
    { minItems: 1, maxItems: 4 },
  ),
});

// =========================================================================
// memory_* 工具
// =========================================================================

export const MEM_TARGET_DESC =
  "Which memory target: 'user' for who the user is (their profile), " +
  "'memory' for your own notes.";

export const MEM_SCOPE_DESC =
  "Which scope to write to / search in: 'global' (cross-project) or 'project' (current project only). " +
  "Omit for the default — writes: 'global' for the user target, 'project' for the memory target; " +
  "reads (memory_search): global entries plus the current project's entries — other projects' entries are never returned.";

export const MEM_ADD_DESC =
  "Append a new entry to memory. Memory has two record types: " +
  "'knowledge' entries are generalizable facts for future sessions (user identity/preferences/habits, stable project conventions " +
  "and decisions, environment facts, reusable lessons — including decisions settled in discussion without an execution process); " +
  "'execution' entries are a dated log of completed tasks — what was done, the result, and the key takeaway " +
  "(including research/comparison/selection tasks that were actually carried out, and verified solutions adopted as standing practice). " +
  "Do NOT record transient state, raw command output, file-by-file change lists, intermediate results and mid-task progress, " +
  "unfinished work, or anything recoverable from the current conversation or code — summarize conclusions instead. " +
  "When in doubt about a knowledge entry, do not record; " +
  "but when a substantial task is completed, always write a concise execution entry and pass kind='execution' explicitly. " +
  "TARGETS: 'user' for who the user is; 'memory' for your own notes. " +
  "SCOPE: omit for the default — 'global' for the user target, 'project' for the memory target. " +
  "KIND: omit for automatic routing (user+global → profile, otherwise knowledge); " +
  "pass 'execution' to record a dated execution-log entry.";

export const MEM_ADD_SNIPPET =
  "Append durable facts to the user profile or your own notes (global or project scope).";

export const MEM_REPLACE_DESC =
  "Replace an existing memory entry. Prefer the entry id from memory_search; " +
  "without an id, locate it by a short unique substring (oldText) and replace with newContent. " +
  "Use this to update outdated entries instead of remove+add. SCOPE defaults like memory_add.";

export const MEM_REPLACE_SNIPPET =
  "Update an existing memory entry (user profile or your notes).";

export const MEM_REMOVE_DESC =
  "Remove a memory entry. Prefer the entry id from memory_search; " +
  "without an id, locate it by a short unique substring (oldText). " +
  "Use when an entry is wrong or no longer relevant. SCOPE defaults like memory_add.";

export const MEM_REMOVE_SNIPPET =
  "Delete a memory entry (user profile or your notes).";

export const MEM_READ_DESC =
  "Read one memory entry in FULL by its id — the only way to get complete content, " +
  "since memory_search returns just an 80-char snippet. ID is required and must come from memory_search; " +
  "no other lookup form is supported. Content is sanitized like search results.";

export const MEM_READ_SNIPPET =
  "Fetch the full content of one memory entry by id (id from memory_search).";

export const MEM_SEARCH_DESC =
  "Hybrid search (BM25 + semantic embeddings) over memory entries, including ones NOT shown in the system prompt. " +
  "Query with a short phrase or sentence — space-separated words act as AND terms. " +
  "SCOPE: omit to search the global entries plus the current project's entries — other projects' entries are never returned; " +
  "'global' / 'project' narrow it explicitly. " +
  "Use this before assuming you don't know something — L2 (project knowledge) and L3 (execution log) " +
  "are searchable but not injected. " +
  "Call this FIRST — before delegating, grepping, or listing files — for knowledge/process questions: " +
  "what this project's structure or dependencies are, which methods/interfaces/files exist, project conventions, " +
  "past decisions, what changed last round, how to build/test, environment and toolchain facts, lessons already learned. " +
  "Answers like these are usually recorded from earlier sessions, so not searching is the same as assuming they don't exist. " +
  "Do NOT search for single-point lookups whose answer can be read in one line (a constant's value, a function signature, a config key). " +
  "Supports Chinese and English queries. " +
  "Optionally narrow by time range with since/until (see timeField for which timestamp they filter on). " +
  "Returns id/title/snippet/score; use the id with memory_replace / memory_remove / memory_read.";

export const MEM_SEARCH_SNIPPET =
  "Search all memory layers (including non-injected L2/L3) with a short phrase or time range.";

/** memory target schema（"memory" | "user"） */
export const MemoryTargetSchema = Type.Union(
  [Type.Literal("memory"), Type.Literal("user")],
  { description: MEM_TARGET_DESC },
);

/** memory scope schema（"global" | "project"） */
export const MemoryScopeSchema = Type.Union(
  [Type.Literal("global"), Type.Literal("project")],
  { description: MEM_SCOPE_DESC },
);

/** memory kind schema（用户画像 / 知识 / 执行流水） */
export const MemoryKindSchema = Type.Union(
  [Type.Literal("knowledge"), Type.Literal("execution")],
  {
    description:
      "Entry class. 'knowledge' (default): durable facts, conventions, decisions — long-term retrievable; " +
      "also for decisions settled in discussion without an execution process. " +
      "'execution': a dated record of a completed task (what was done, result, takeaway; includes research/comparison/selection tasks " +
      "that were actually carried out, and verified solutions adopted as standing practice) — write one whenever a substantial task is completed, always passing kind='execution' explicitly. " +
      "Omit to route by target+scope.",
  },
);

/** since/until 依据哪个时间列（默认更新时间） */
export const MemoryTimeFieldSchema = Type.Union(
  [Type.Literal("updated"), Type.Literal("created")],
  {
    description:
      "Which timestamp `since`/`until` filter on. 'updated' (default): a replaced entry looks new. " +
      "'created': first written; unaffected by later edits.",
  },
);

/**
 * memory_search 参数——kernel 工具与 pi bridge 扩展共用同一份定义。
 * 时间边界接受毫秒时间戳或日期串（'YYYY-MM-DD' 按本地时区，until 含当天）。
 */
export const MemorySearchParamsSchema = Type.Object({
  query: Type.String({
    description:
      "A short phrase or sentence describing what to recall (Chinese or English). Prefer one coherent phrase — space-separated words act as AND terms and match nothing unless all of them appear in the same entry.",
  }),
  scope: Type.Optional(MemoryScopeSchema),
  kind: Type.Optional(MemoryKindSchema),
  limit: Type.Optional(
    Type.Number({ description: "Max results (default 10)." }),
  ),
  includeArchived: Type.Optional(
    Type.Boolean({
      description: "Include archived entries (default false).",
    }),
  ),
  since: Type.Optional(
    Type.Union([Type.Number(), Type.String()], {
      description:
        "Only entries at/after this time (inclusive). Accepts a millisecond timestamp, or a date string: " +
        "'YYYY-MM-DD' means local midnight of that day, other strings use Date.parse. " +
        "Unparseable values are ignored (no lower bound).",
    }),
  ),
  until: Type.Optional(
    Type.Union([Type.Number(), Type.String()], {
      description:
        "Only entries at/before this time (inclusive). Same formats as `since`; " +
        "'YYYY-MM-DD' covers the whole local day (end of day). Unparseable values are ignored.",
    }),
  ),
  timeField: Type.Optional(MemoryTimeFieldSchema),
});

// =========================================================================
// knowledge_search
// =========================================================================

/** knowledge_search 单次返回条数上限（与 kernel search/contracts.ts 的 MAX_SEARCH_RESULTS 同值） */
export const KB_SEARCH_LIMIT_MAX = 50;

/** 分页窗口上限（offset + limit；与 kernel search/contracts.ts 的 MAX_SEARCH_WINDOW 同值） */
export const KB_SEARCH_WINDOW_MAX = 800;

/** 检索模式（对齐 pi-knowledge 0.13.0 的 12 个取值；code/config/errors/docs/decision 为意图别名） */
export const KB_SEARCH_MODES = [
  "auto",
  "fast",
  "semantic",
  "hybrid",
  "semantic_hybrid",
  "deep",
  "adaptive",
  "code",
  "config",
  "docs",
  "errors",
  "decision",
] as const satisfies readonly KbSearchMode[];

/** 检索预算 profile 的 8 个取值 */
export const KB_SEARCH_PROFILES = [
  "auto",
  "balanced",
  "low_token",
  "precision",
  "recall",
  "long_context",
  "code",
  "docs",
] as const satisfies readonly KbSearchProfile[];

/** 结果多样性档位 */
export const KB_SEARCH_DIVERSITIES = ["off", "balanced", "strong"] as const;

export const KB_SEARCH_DESCRIPTION =
  "Search the built-in knowledge bases bound to this agent " +
  "(requirements, PRDs, specs and other product/business documents — the available list is in the system prompt) " +
  "using lexical BM25, semantic vectors, reranking and filters. " +
  "Query with a short phrase or sentence — space-separated words act as AND terms. Supports Chinese and English. " +
  "Use it to find relevant context before answering domain questions, before citing or quoting requirement/spec documents, " +
  "and whenever you are unsure whether memory already covers it. " +
  "Pick the mode deliberately: hybrid (default) for most questions with useful lexical anchors — it fuses BM25 and semantic vectors but still requires keyword evidence; " +
  "fast for exact symbols, filenames, commands, error codes, API names, config keys or quoted strings; " +
  "semantic for pure vector search when exact terms may differ from the indexed wording; " +
  "semantic_hybrid for vector recall plus BM25/fusion scoring without the hybrid lexical-evidence gate; " +
  "adaptive when you need surrounding implementation context or nearby sections; " +
  "deep for high-stakes answers, ambiguous top results or final verification where slower cross-encoder reranking is acceptable; " +
  "auto to let the tool pick fast/semantic/hybrid from the query shape and retry weaker results along a fallback chain; " +
  "code/config/errors are shortcuts for code-and-config lookups (retrieval like fast), docs/decision for prose documents and decision records (retrieval like hybrid). " +
  "Pick the profile when the default budget does not fit: low_token for slow local models that need fewer, stricter, longer snippets; " +
  "precision for identifiers/errors; recall or long_context for broad prose/document research; code/docs for their respective corpora. " +
  "If a search returns no results or obviously weak results, retry once with a different mode before concluding the KB lacks the answer. " +
  "If top results are repetitive, retry with diversity 'strong' or mode 'adaptive' instead of increasing the limit first. " +
  "An empty result means the knowledge bases do not contain it — NOT that the fact does not exist; " +
  "do not treat absence as refutation, fall back to asking the user or the source documents. " +
  "Returns content/file_path/title/breadcrumb/lines/kb_name/score per hit, best first, plus total_count/has_more for paging " +
  "(and tuning when diagnostics=true). An empty page with offset > 0 means no more results, not that the KB lacks the answer. " +
  "A hit carrying `stale: true` comes from an outdated index — the source file changed or failed to extract " +
  "after the last successful indexing, so the chunk may lag behind the document on disk. " +
  "Such hits are still the best available answer, but verify important details against the current file, " +
  "quote them only with that caveat, and tell the user the knowledge base needs re-indexing.";

export const KB_SEARCH_SNIPPET =
  "Search knowledge bases (hybrid is lexical-anchored BM25 + semantic fusion); 12 modes / 8 profiles, paging and metadata filters. " +
  "Hits return content/file_path/title/breadcrumb/lines/kb_name/score (plus stale/mode/rerank_used when applicable).";

/** knowledge_search 参数——kernel 工具与 pi bridge 扩展共用同一份定义。 */
export const KB_SEARCH_PARAMS_SCHEMA = Type.Object({
  query: Type.String({
    description:
      "A short phrase or sentence describing what to look up (Chinese or English). " +
      "Prefer one coherent phrase — space-separated words act as AND terms.",
  }),
  mode: Type.Optional(
    Type.Union(
      KB_SEARCH_MODES.map((mode) => Type.Literal(mode)),
      {
        description:
          "Search mode (12 values; code/config/errors/docs/decision are intent aliases of the six retrieval strategies): " +
          "hybrid (default) = BM25 + vector fusion with lexical anchoring, score gate 0.18 and lexical-evidence gate; " +
          "fast = strict BM25 phrase only (no OR fallback, no vectors) for identifiers, paths, error codes; " +
          "semantic = pure vector recall, no lexical anchoring and no gate; " +
          "semantic_hybrid = fusion without lexical anchoring/evidence gate (score gate only); " +
          "adaptive = hybrid plus same-file line window (±80 lines, max 5 neighbours); " +
          "deep = hybrid with wider candidates (limit×3) then cross-encoder rerank (needs Deep rerank enabled; falls back to hybrid when unavailable); " +
          "auto = picks fast/semantic/hybrid from the query shape and retries weaker results along a fallback chain (max 3 attempts); " +
          "code/config/errors cover code/config/error-code lookups and retrieve like fast; docs/decision cover prose documents and decision records and retrieve like hybrid.",
      },
    ),
  ),
  profile: Type.Optional(
    Type.Union(
      KB_SEARCH_PROFILES.map((profile) => Type.Literal(profile)),
      {
        description:
          "Search budget profile (8 values): auto (default) = choose from the query shape and mode; " +
          "balanced = general purpose (10 hits); low_token = fewer, stricter, longer snippets for slow local models; " +
          "precision = identifiers/errors, high score gate and 5 hits; recall = broad coverage with a low gate; " +
          "long_context = long snippets and wide adaptive windows for prose/document research; " +
          "code / docs = budgets tuned for their corpora.",
      },
    ),
  ),
  limit: Type.Optional(
    Type.Number({
      description:
        `Max results, 1-${KB_SEARCH_LIMIT_MAX} (default comes from the search profile/env).`,
      minimum: 1,
      maximum: KB_SEARCH_LIMIT_MAX,
      multipleOf: 1,
    }),
  ),
  offset: Type.Optional(
    Type.Number({
      description: `Pagination offset; offset + limit must not exceed ${KB_SEARCH_WINDOW_MAX}`,
      minimum: 0,
      maximum: KB_SEARCH_WINDOW_MAX - 1,
      multipleOf: 1,
    }),
  ),
  kb_id: Type.Optional(
    Type.String({
      description: "Limit search to a specific KB by ID or exact name",
    }),
  ),
  file_type: Type.Optional(
    Type.String({
      description: "Filter by file type (e.g. typescript, markdown, python)",
    }),
  ),
  path_pattern: Type.Optional(
    Type.String({
      description: "Filter by file path substring (for example src/engine.ts)",
    }),
  ),
  diversity: Type.Optional(
    Type.Union(
      KB_SEARCH_DIVERSITIES.map((diversity) => Type.Literal(diversity)),
      {
        description:
          "Result diversity: off = pure relevance order, no per-file spread; balanced (default) = light MMR de-duplication; " +
          "strong = prefer one hit per file when top results are repetitive.",
      },
    ),
  ),
  diagnostics: Type.Optional(
    Type.Boolean({
      description:
        "Include ranking diagnostics and mode/fallback details in the result",
    }),
  ),
});

/** knowledge_read：按文件路径或块 id 读回**已抽取的正文**（docx/pdf 是二进制，read 工具读不了） */
export const KB_READ_DESCRIPTION =
  "Read the extracted text of a knowledge-base file (or a chunk's neighbourhood) instead of opening the raw file. " +
  "Knowledge bases index PDF/DOCX/PDF/HTML/TXT/MD files by extracting their text; the original file may be binary and unreadable by the read tool. " +
  "Call this after knowledge_search when you need the full document or more surrounding context: pass the hit's `file_path` (relative to the KB root) or its `chunk_id`. " +
  "Absolute paths are also accepted (file_path_abs from knowledge_search). " +
  "Returns the extracted text plus the relative/absolute path and line range.";

export const KB_READ_SNIPPET =
  "Read extracted text of a knowledge-base file or a chunk's neighbourhood (by file_path or chunk_id).";

export const KB_READ_PARAMS_SCHEMA = Type.Object({
  file_path: Type.Optional(
    Type.String({
      description:
        "File path inside the knowledge base: relative to the KB root (as returned in knowledge_search hits) or absolute (file_path_abs).",
    }),
  ),
  chunk_id: Type.Optional(
    Type.String({
      description:
        "Chunk id from a knowledge_search hit; returns that chunk plus the surrounding chunks (see before/after).",
    }),
  ),
  kb_id: Type.Optional(
    Type.String({ description: "Restrict the read to one knowledge base (must be bound to this agent)." }),
  ),
  before: Type.Optional(
    Type.Number({ description: "Chunks to include before chunk_id (default 1).", minimum: 0, maximum: 20 }),
  ),
  after: Type.Optional(
    Type.Number({ description: "Chunks to include after chunk_id (default 1).", minimum: 0, maximum: 20 }),
  ),
  max_chars: Type.Optional(
    Type.Number({ description: "Max characters returned (default 20000).", minimum: 200, maximum: 200000 }),
  ),
});

// =========================================================================
// delegate
// =========================================================================

export const DELEGATE_DESCRIPTION = [
  "把任务委托给子智能体执行（隔离上下文，结果回到本会话）。",
  "- 判据：自己得跨多个文件或反复检索才摸得清才派；不需要翻的自己做（委派要付一次上下文交接）。",
  "- 不派：已知路径的单个文件、少量已知文件里搜、一两步能办完的事、要用户拍板的事。",
  "- 专项优先：任务落在名单中任一专员的领域（前端/后端/评审/质量分析/业务数据/需求/设计/纪要/任务拆解…）时，优先派该专员，通用只兜底没有专员覆盖的多步执行任务。",
  "- 派：跨多文件的探索/审计/调查；需先读懂结构再动的改动。",
  "- 任务怎么写：子代理没看过这段对话——目标、你已经知道的、确切路径或命令都写进任务里；要它调查只给问题不给步骤；别把「你自己搞明白」外包出去；任务自含范围、输出、约束。",
  "- 有依赖（先…再…/然后/取决于）→ 拆成多次调用，每次 1 项；无依赖且 ≥2 个对象做同样的事 → 一次调用里每对象 1 项并行（汇总/对比自己做不算依赖）。",
  "- 派出去就留给它：别自己重搜一遍、别中途抢回来自己做；结果只有你能看到，要给用户看就自己转述。",
  "- tasks：1..6 项，每项 { agent, task }，超出拒绝不排队。",
  "- resume：填上次返回的 <agent_id>，同一子智能体接着做（保留其上下文，优先于新建）。",
  "- thinking：可选，本次委派的思考强度（disabled/medium/high/max）；不传则按既有优先级（agent 覆盖配置 > 继承主代理当前等级）。",
].join("\n");

/** 单次委托的任务数上限（并发上限与参数上限同源，避免数值与文案脱节） */
export const DELEGATE_MAX_TASKS = 6;

export const DelegateParamsSchema = Type.Object({
  tasks: Type.Array(
    Type.Object({
      agent: Type.String({
        description: "子智能体名称（见 Available Subagents 清单）",
      }),
      task: Type.String({ description: "交给该子智能体的任务描述" }),
      resume: Type.Optional(
        Type.String({
          description: "要续聊的子代理 agent_id（来自上次返回的 <agent_id>）",
        }),
      ),
      // thinking：可选，本次委派的思考强度覆盖；不传=按既有优先级（agent 覆盖配置 > 继承主代理当前等级）
      thinking: Type.Optional(
        Type.Union(
          [
            Type.Literal("disabled"),
            Type.Literal("medium"),
            Type.Literal("high"),
            Type.Literal("max"),
          ],
          {
            description:
              "本次委派的思考强度（可选）；不传则按该 agent 的覆盖配置或继承主代理当前思考等级",
          },
        ),
      ),
    }),
    { minItems: 1, maxItems: DELEGATE_MAX_TASKS },
  ),
});

// =========================================================================

export const PREVIEW_OPEN_DESCRIPTION =
  "把网址或项目内 html 送到用户的内置预览面板。url/path 二选一。";

export const PreviewOpenParamsSchema = Type.Object({
  url: Type.Optional(
    Type.String({ description: "http/https 网址（如 http://example.com）" }),
  ),
  path: Type.Optional(
    Type.String({ description: "项目内 .html/.htm 文件绝对路径" }),
  ),
});

// =========================================================================
// 所有宿主工具名列表
// =========================================================================

export const BRIDGE_TOOL_NAMES = [
  "ask_user_question",
  "memory_add",
  "memory_replace",
  "memory_remove",
  "memory_read",
  "memory_search",
  "delegate",
  "preview_open",
] as const;

export type BridgeToolName = (typeof BRIDGE_TOOL_NAMES)[number];
