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
  "Which memory file: 'memory' (your notes → MEMORY.md) or 'user' (user profile → USER.md).";

export const MEM_SCOPE_DESC =
  "Where this entry lives: 'global' (cross-project) or 'project' (current project only). " +
  "Omit for the default — 'global' for the user target, 'project' for the memory target.";

export const MEM_ADD_DESC =
  "Append a new entry to memory. Save durable information that survives across sessions " +
  "(user preferences, corrections, stable environment facts, conventions). Do NOT save task progress or temporary state. " +
  "TARGETS: 'user' for who the user is; 'memory' for your own notes. " +
  "SCOPE: omit for default (user→global, memory→project), or set 'global'/'project' explicitly.";

export const MEM_ADD_SNIPPET =
  "Append durable facts to MEMORY.md or USER.md (global or project scope).";

export const MEM_REPLACE_DESC =
  "Replace an existing memory entry. Find it by a short unique substring (oldText), replace with newContent. " +
  "Use this to update outdated entries instead of remove+add. SCOPE defaults like memory_add.";

export const MEM_REPLACE_SNIPPET = "Update an existing MEMORY.md or USER.md entry.";

export const MEM_REMOVE_DESC =
  "Remove a memory entry by a short unique substring (oldText). Use when an entry is wrong or no longer relevant. " +
  "SCOPE defaults like memory_add.";

export const MEM_REMOVE_SNIPPET = "Delete an entry from MEMORY.md or USER.md.";

export const MEM_READ_DESC =
  "Return live entries and usage for a memory store. Inspect what's saved before deciding to add/replace/remove. " +
  "SCOPE defaults like memory_add.";

export const MEM_READ_SNIPPET = "Read the current contents of MEMORY.md or USER.md.";

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
  "不要使用 delegate：",
  "- 单点定义查询（常量值、函数签名、配置项），答案一行能念完——哪怕含几个名字——自己做。",
  "  但要逐条列出/逐条解释多个条目（哪怕条目都在一个文件里）仍然是派发，不是单点查询。",
  "- 需要与用户来回交互的任务。",
  "",
  "任务写法：自含范围、输出格式、约束；表达意图而非转发原文。返回后直接采用其结果，不要自己重做。",
].join("\n");

export const DelegateParamsSchema = Type.Object({
  agent: Type.String({
    description:
      "可调起列表中的子智能体(subagent)名称",
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
// 所有宿主工具名列表
// =========================================================================

export const BRIDGE_TOOL_NAMES = [
  "ask_user_question",
  "memory_add",
  "memory_replace",
  "memory_remove",
  "memory_read",
  "delegate",
  "fleet",
] as const;

export type BridgeToolName = (typeof BRIDGE_TOOL_NAMES)[number];
