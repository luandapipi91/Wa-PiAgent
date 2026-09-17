// tool-schemas.ts —— 宿主工具的共享文案与 TypeBox Schema
//
// 本文件是 WaPi 7 个宿主工具描述和参数 schema 的唯一真源。
// Kernel 侧（delegate-tool / ask-tool / amaster-memory）和
// Pi bridge 扩展（wa-pi-bridge.ts）均从此处引用，消除文案重复。
//
// 依赖：仅 typebox（Pi 进程和 WaPi kernel 均可用）。

import { Type } from "typebox";

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
  "Where this entry lives: 'global' (cross-project) or 'project' (current project only). " +
  "Omit for the default — 'global' for the user target, 'project' for the memory target.";

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
  "Replace an existing memory entry. Prefer the entry id from memory_search / memory_read; " +
  "without an id, locate it by a short unique substring (oldText) and replace with newContent. " +
  "Use this to update outdated entries instead of remove+add. SCOPE defaults like memory_add.";

export const MEM_REPLACE_SNIPPET =
  "Update an existing memory entry (user profile or your notes).";

export const MEM_REMOVE_DESC =
  "Remove a memory entry. Prefer the entry id from memory_search / memory_read; " +
  "without an id, locate it by a short unique substring (oldText). " +
  "Use when an entry is wrong or no longer relevant. SCOPE defaults like memory_add.";

export const MEM_REMOVE_SNIPPET =
  "Delete a memory entry (user profile or your notes).";

export const MEM_READ_DESC =
  "Return live entries and usage for a memory store. Inspect what's saved before deciding to add/replace/remove. " +
  "SCOPE defaults like memory_add.";

export const MEM_READ_SNIPPET =
  "Read the current contents of a memory store (user profile or your notes).";

export const MEM_SEARCH_DESC =
  "Full-text (BM25) search across all memory layers, including entries NOT shown in the system prompt. " +
  "Use this before assuming you don't know something — L2 (project knowledge) and L3 (execution log) " +
  "are searchable but not injected. Supports Chinese and English queries. " +
  "Optionally narrow by time range with since/until (see timeField for which timestamp they filter on). " +
  "Returns id/title/snippet/score; use the id with memory_replace / memory_remove.";

export const MEM_SEARCH_SNIPPET =
  "Search all memory layers (including non-injected L2/L3) by keyword or time range.";

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
    description: "Keywords to search for (Chinese or English).",
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
// delegate
// =========================================================================

export const DELEGATE_DESCRIPTION = [
  "在隔离上下文中运行子智能体（subagent）并返回其结果；主代理阻塞等待其完成。",
  "",
  "默认委托：答案散落在多处、需要搜索/遍历代码才能汇总的问题——列表/枚举/审计/调查/总结/原理/归类——",
  "哪怕只涉及一个文件或目录，第一个工具调用就应该是 delegate，不要自己先 grep/read。",
  "已给出路径也不是自己做的理由。",
  "",
  "改用 fleet：待办是多个互相独立的子任务，且每个任务的范围/输出格式/约束现在就能独立写全 → 一次 fleet 并行派发，" +
  "不要连续 delegate 多次。反之后一个任务依赖前一个结果、或对同一处文件逐步推进 → 逐个 delegate。",
  "",
  "不要使用 delegate：",
  "- 单点定义查询（常量值、函数签名、配置项），答案一行能念完——哪怕含几个名字——自己做。",
  "  但要逐条列出/逐条解释多个条目（哪怕条目都在一个文件里）仍然是派发，不是单点查询。",
  "- 需要与用户来回交互的任务。",
  "",
  "任务写法：自含范围、输出格式、约束；表达意图而非转发原文。返回后直接采用其结果，不要自己重做。",
].join("\n");

export const DelegateParamsSchema = Type.Object({
  agent: Type.String({
    description: "可调起列表中的子智能体(subagent)名称",
  }),
  task: Type.String({ description: "交给子智能体的任务描述" }),
});

// =========================================================================
// fleet
// =========================================================================

export const FLEET_DESCRIPTION = [
  "Run multiple subagents in parallel, each in its own isolated context, and return all results together.",
  "The call blocks the main agent until every subagent finishes.",
  "Each task's `agent` must be a name from the Available Subagents list.",
  "",
  "Choose fleet over sequential delegate calls when you can write out every task's scope, output format, and constraints",
  "right now, with no task waiting on another task's result.",
  "",
  "Use fleet when multiple independent subtasks can run at once:",
  "- Multi-keyword or multi-directory parallel exploration.",
  "- Codebase-wide audit across unrelated modules.",
  "- Multiple independent bugs or files investigated in parallel.",
  "",
  "Do NOT use fleet when:",
  "- Tasks depend on each other (use sequential delegate calls instead).",
  "- Tasks touch the same files or shared state (write-heavy parallel work causes conflicts).",
  "- You only have one task (use delegate, not fleet).",
  "",
  "Guidelines:",
  "- Keep tasks independent and self-contained (paths, context, expected output).",
  "- Concurrency limit is 5; do not exceed it.",
  "- Decide how many subagents to spawn from the task shape; do not wait for the user to specify a count.",
].join("\n");

export const FleetParamsSchema = Type.Object({
  tasks: Type.Array(
    Type.Object({
      agent: Type.String({ description: "可调起列表中的智能体名称" }),
      task: Type.String({
        description: "交给该智能体的任务描述（按任务合约范式组织）",
      }),
    }),
  ),
});

// =========================================================================
// browser_* 工具（Bun.WebView 浏览器自动化）
// =========================================================================

export const BROWSER_NAVIGATE_DESCRIPTION =
  "在浏览器视图中加载一个 URL（首次调用自动创建视图）。页面主 frame load 事件后返回。用于抓取 JS 渲染页面/进入自动化流程起点。";

export const BrowserNavigateParamsSchema = Type.Object({
  url: Type.String({ description: "http/https 或 about:blank URL" }),
  width: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 16384,
      description: "视口宽（仅新建视图时生效，默认 800）",
    }),
  ),
  height: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 16384,
      description: "视口高（仅新建视图时生效，默认 600）",
    }),
  ),
  timeout: Type.Optional(
    Type.Integer({
      minimum: 1000,
      description: "页面加载超时毫秒数（默认 120000）",
    }),
  ),
});

export const BROWSER_EVALUATE_DESCRIPTION = [
  "在浏览器视图中执行 JS 表达式或 DOM 操作（点击/输入/按键/滚动）。所有操作派发原生浏览器事件（event.isTrusted === true）。",
  "action:",
  "- eval: 执行 JS 表达式（自动 await Promise），结果 JSON 序列化返回（超长截断）",
  "- click: 按 CSS selector 等元素可操作后点击其中心，或按视口坐标 (x,y) 点击",
  "- type: 向当前焦点元素插入文本（等价粘贴，无 keydown）",
  "- press: 按命名键（Enter/Tab/ArrowDown/Escape...）或单字符+修饰键",
  "- scroll: 按像素增量滚动（正 dy 向下）",
  "- scrollTo: 滚动使元素进入视口",
].join("\n");

export const BrowserEvaluateParamsSchema = Type.Object({
  action: Type.Union([
    Type.Literal("eval"),
    Type.Literal("click"),
    Type.Literal("type"),
    Type.Literal("press"),
    Type.Literal("scroll"),
    Type.Literal("scrollTo"),
  ]),
  script: Type.Optional(
    Type.String({ description: "action=eval 时的 JS 表达式" }),
  ),
  selector: Type.Optional(
    Type.String({ description: "action=click/scrollTo 时的 CSS selector" }),
  ),
  x: Type.Optional(
    Type.Integer({ description: "action=click 时的视口 x 坐标" }),
  ),
  y: Type.Optional(
    Type.Integer({ description: "action=click 时的视口 y 坐标" }),
  ),
  button: Type.Optional(
    Type.Union([
      Type.Literal("left"),
      Type.Literal("right"),
      Type.Literal("middle"),
    ]),
  ),
  modifiers: Type.Optional(
    Type.Array(
      Type.Union([
        Type.Literal("Shift"),
        Type.Literal("Control"),
        Type.Literal("Alt"),
        Type.Literal("Meta"),
      ]),
    ),
  ),
  clickCount: Type.Optional(Type.Integer({ minimum: 1, maximum: 3 })),
  text: Type.Optional(Type.String({ description: "action=type 时的文本" })),
  key: Type.Optional(
    Type.String({ description: "action=press 时的键名或单字符" }),
  ),
  dx: Type.Optional(Type.Integer({ description: "action=scroll 的水平增量" })),
  dy: Type.Optional(Type.Integer({ description: "action=scroll 的垂直增量" })),
  block: Type.Optional(
    Type.Union([
      Type.Literal("start"),
      Type.Literal("center"),
      Type.Literal("end"),
      Type.Literal("nearest"),
    ]),
  ),
  timeout: Type.Optional(
    Type.Integer({
      minimum: 100,
      description: "等待元素可操作/存在的毫秒数（默认 30000）",
    }),
  ),
});

export const BROWSER_SCREENSHOT_DESCRIPTION =
  "截取当前浏览器视图的视口图像。默认保存到 wa-pi 临时目录并返回文件路径（避免 base64 撑爆 token）；return=base64 时内联返回 data URL。";

export const BrowserScreenshotParamsSchema = Type.Object({
  format: Type.Optional(
    Type.Union([
      Type.Literal("png"),
      Type.Literal("jpeg"),
      Type.Literal("webp"),
    ]),
  ),
  quality: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
  return: Type.Optional(
    Type.Union([Type.Literal("path"), Type.Literal("base64")]),
  ),
});

export const BROWSER_CLOSE_DESCRIPTION =
  "关闭当前会话的浏览器视图，释放浏览器进程资源。视图不存在时静默返回。";

export const BrowserCloseParamsSchema = Type.Object({});

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
  "fleet",
  "browser_navigate",
  "browser_evaluate",
  "browser_screenshot",
  "browser_close",
] as const;

export type BridgeToolName = (typeof BRIDGE_TOOL_NAMES)[number];
