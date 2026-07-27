// tool-schemas.ts —— 宿主工具的共享文案与 TypeBox Schema
//
// 本文件是 HiAgent 7 个宿主工具描述和参数 schema 的唯一真源。
// Kernel 侧（delegate-tool / ask-tool / amaster-memory）和
// Pi bridge 扩展（hiagent-bridge.ts）均从此处引用，消除文案重复。
//
// 依赖：仅 typebox（Pi 进程和 HiAgent kernel 均可用）。

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
  "Run a specialized subagent in an isolated context to handle a delegated task, then return its result.",
  "The subagent runs with its own tools and system prompt; the main agent cannot continue until it returns.",
  "\n",
  "Default to delegating multi-step exploration (requests needing several reads/searches) to this",
  "tool—it keeps noisy tool sequences out of your context. Do single lookups and 1-2 file reads yourself.",
  "\n",
  "Use delegate when delegation fits:",
  "- The task is exploratory or codebase-wide (search, survey, architecture understanding).",
  "- The task needs many noisy tool calls (repeated grep/read) that would bloat the main context.",
  "- The task is self-contained and the subagent's focused output is what you need to proceed.",
  "- Each subagent's <whenToDelegate> / <whenNotTo> / <benefit> in the Available Subagents list tells you when to pick it.",
  "\n",
  "Do NOT use delegate when:",
  "- The answer is a simple lookup, quick edit, or single-step task you can do directly with read/grep/edit.",
  "- The task needs frequent user back-and-forth.",
  "- The task is latency-sensitive and the main agent can do it in one step.",
  "",
  "When delegating, write a self-contained task:",
  "- Include file paths, context, expected output, and whether the subagent may edit files.",
  "- Do not forward the user's raw text verbatim; synthesize a focused task contract.",
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
  "- Concurrency limit is 6; do not exceed it.",
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
