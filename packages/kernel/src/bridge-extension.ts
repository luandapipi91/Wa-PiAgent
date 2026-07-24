// bridge-extension.ts — 生成 hiagent-bridge.ts（pi 扩展）到 GENERATED_DIR。
//
// 背景：RPC 模式下 pi 以子进程运行，SDK 的 customTools 机制不存在。
// 替代方案：kernel 生成本扩展文件，pi 经 -e 加载并注册 7 个宿主工具
// （ask_user_question / memory_add / memory_replace / memory_remove / memory_read /
// delegate / fleet）。工具 execute 在 pi 进程内经 HTTP 回调 kernel 的 /bridge/tool，
// kernel 复用现有宿主逻辑执行后把 { content, details } 返回给扩展。
//
// 工具的 name/description/parameters 与 SDK 时代的实现完全一致（agent 可见契约不变）：
// schema 与文案复制自 ask-tool.ts / amaster-memory.ts / delegate-tool.ts——
// 这三处变更时需同步更新本文件。
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { GENERATED_DIR } from "@hiagent/shared";

/** 生成的 bridge 扩展文件路径（kernel spawn pi 时经 -e 注入） */
export const BRIDGE_EXTENSION_PATH = join(GENERATED_DIR, "hiagent-bridge.ts");

// ---- 工具文案（与现有实现逐字一致，勿改措辞）----

// 来自 ask-tool.ts makeAskTool
const ASK_DESCRIPTION =
  "向用户提出 1-4 个结构化澄清问题（每问 2-4 个选项），代替瞎猜。每个问题可单选或多选；" +
  "用户可填「其他」自由文本或取消。返回 details.answers（含 kind: option|custom|multi）或 cancelled。";
const ASK_PROMPT_GUIDELINES = [
  "当存在会显著改变实现的歧义、且不值得自己合理假设时再用；一次问最少必要的问题；",
  "选项文案简洁，给出取舍说明；不要用于确认显而易见的事。",
];

// 来自 amaster-memory.ts createAgentMemoryTools
const MEM_TARGET_DESC =
  "Which memory file: 'memory' (your notes → MEMORY.md) or 'user' (user profile → USER.md).";
const MEM_SCOPE_DESC =
  "Where this entry lives: 'global' (cross-project) or 'project' (current project only). " +
  "Omit for the default — 'global' for the user target, 'project' for the memory target.";
const MEM_ADD_DESC =
  "Append a new entry to memory. Save durable information that survives across sessions " +
  "(user preferences, corrections, stable environment facts, conventions). Do NOT save task progress or temporary state. " +
  "TARGETS: 'user' for who the user is; 'memory' for your own notes. " +
  "SCOPE: omit for default (user→global, memory→project), or set 'global'/'project' explicitly.";
const MEM_ADD_SNIPPET = "Append durable facts to MEMORY.md or USER.md (global or project scope).";
const MEM_REPLACE_DESC =
  "Replace an existing memory entry. Find it by a short unique substring (oldText), replace with newContent. " +
  "Use this to update outdated entries instead of remove+add. SCOPE defaults like memory_add.";
const MEM_REPLACE_SNIPPET = "Update an existing MEMORY.md or USER.md entry.";
const MEM_REMOVE_DESC =
  "Remove a memory entry by a short unique substring (oldText). Use when an entry is wrong or no longer relevant. " +
  "SCOPE defaults like memory_add.";
const MEM_REMOVE_SNIPPET = "Delete an entry from MEMORY.md or USER.md.";
const MEM_READ_DESC =
  "Return live entries and usage for a memory store. Inspect what's saved before deciding to add/replace/remove. " +
  "SCOPE defaults like memory_add.";
const MEM_READ_SNIPPET = "Read the current contents of MEMORY.md or USER.md.";

// 来自 delegate-tool.ts delegateDescription()
const DELEGATE_DESCRIPTION = [
  "Run a specialized subagent in an isolated context to handle a delegated task, then return its result.",
  "The subagent runs with its own tools and system prompt; the main agent cannot continue until it returns.",
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

// 来自 delegate-tool.ts makeFleetTool（并发上限写死为 6，与 MAX_SUBAGENT_CONCURRENCY 同步）
const FLEET_DESCRIPTION = [
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

/**
 * 生成 bridge 扩展源码（纯文本，幂等）。
 * 生成的文件由 pi 的 jiti 加载，可 import "@earendil-works/pi-coding-agent" 与 "typebox"
 * （pi 已配别名），但不能 import 任何 kernel 代码——宿主逻辑全部经 /bridge/tool 回调。
 */
export function generateBridgeExtension(): string {
  return `// 自动生成，勿手改 — 由 HiAgent bridge-extension.ts 生成（RPC 模式宿主工具桥）
// pi 进程加载本扩展注册宿主工具；execute 经 HTTP 回调 kernel 的 /bridge/tool 端点。
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// kernel spawn pi 时注入的三个环境变量
const BRIDGE_URL = process.env.HIAGENT_BRIDGE_URL;
const BRIDGE_TOKEN = process.env.HIAGENT_BRIDGE_TOKEN;
const BRIDGE_SESSION_ID = process.env.HIAGENT_SESSION_ID;

const DEFAULT_TIMEOUT_MS = 60_000; // 普通工具 60s
const ASK_TIMEOUT_MS = 600_000;    // ask 等用户回答，放宽到 10 分钟

type BridgeToolResult = { content: Array<{ type: "text"; text: string }>; details?: unknown };

function missingEnvError(): string | null {
  if (!BRIDGE_URL || !BRIDGE_TOKEN || !BRIDGE_SESSION_ID) {
    return "bridge 环境变量缺失（HIAGENT_BRIDGE_URL / HIAGENT_BRIDGE_TOKEN / HIAGENT_SESSION_ID）：该工具只在 hiagent 宿主下可用";
  }
  return null;
}

function failResult(text: string, error: string): BridgeToolResult {
  return { content: [{ type: "text", text }], details: { error } };
}

// 经 HTTP 回调 kernel /bridge/tool。任何失败（网络/非 2xx/超时/格式非法）都转成
// 文本结果返回，绝不抛出——避免异常导致 pi 进程崩溃。
async function callBridge(
  tool: string,
  toolCallId: string,
  params: unknown,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<BridgeToolResult> {
  const missing = missingEnvError();
  if (missing) return failResult(missing, "missing_env");
  // 工具 signal（用户中断）与超时合并为一个 controller
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("bridge 调用超时 (" + timeoutMs + "ms)")), timeoutMs);
  const onToolAbort = () => ctrl.abort((signal && signal.reason) || new Error("aborted"));
  if (signal) {
    if (signal.aborted) onToolAbort();
    else signal.addEventListener("abort", onToolAbort, { once: true });
  }
  try {
    const res = await fetch(BRIDGE_URL + "/bridge/tool", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: BRIDGE_TOKEN, sessionId: BRIDGE_SESSION_ID, toolCallId, tool, params }),
      signal: ctrl.signal,
    });
    const data = (await res.json().catch(() => null)) as any;
    if (!res.ok) {
      const errMsg = data && typeof data.error === "string" ? data.error : "http_" + res.status;
      return failResult("bridge 调用失败: " + errMsg, errMsg);
    }
    if (!data || !Array.isArray(data.content)) {
      return failResult("bridge 调用失败: 响应格式非法", "invalid_response");
    }
    return { content: data.content, details: data.details };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return failResult("bridge 调用失败: " + msg, msg);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onToolAbort);
  }
}

// ---- schema：与 kernel 侧现有实现逐字一致 ----

// ask_user_question（复制自 ask-tool.ts）
const AskParamsSchema = Type.Object({
  questions: Type.Array(
    Type.Object({
      question: Type.String({ description: "完整问题文本，以 ? 结尾" }),
      header: Type.String({ description: "chip 标签文字，≤16 字符" }),
      multiSelect: Type.Optional(Type.Boolean({ description: "是否多选，默认 false" })),
      options: Type.Array(
        Type.Object({
          label: Type.String({ description: "1-5 词，≤60 字符" }),
          description: Type.String({ description: "解释该选项/取舍" }),
          preview: Type.Optional(Type.String({ description: "可选 markdown，随选项展示" })),
        }),
        { minItems: 2, maxItems: 4 },
      ),
    }),
    { minItems: 1, maxItems: 4 },
  ),
});

// memory_*（复制自 amaster-memory.ts createAgentMemoryTools）
const memoryTargetSchema = Type.Union([Type.Literal("memory"), Type.Literal("user")], {
  description: ${JSON.stringify(MEM_TARGET_DESC)},
});
const memoryScopeSchema = Type.Union([Type.Literal("global"), Type.Literal("project")], {
  description: ${JSON.stringify(MEM_SCOPE_DESC)},
});

// delegate / fleet（复制自 delegate-tool.ts）
const DelegateParamsSchema = Type.Object({
  agent: Type.String({ description: "可调起列表中的智能体名称，或内置 subagent 类型名（general-purpose / Explore / Plan）" }),
  task: Type.String({ description: "交给子智能体的任务描述" }),
});
const FleetParamsSchema = Type.Object({
  tasks: Type.Array(Type.Object({
    agent: Type.String({ description: "可调起列表中的智能体名称" }),
    task: Type.String({ description: "交给该子智能体的任务描述（按任务合约范式组织）" }),
  })),
});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user_question",
    label: "Ask User",
    description: ${JSON.stringify(ASK_DESCRIPTION)},
    promptGuidelines: ${JSON.stringify(ASK_PROMPT_GUIDELINES)},
    parameters: AskParamsSchema,
    async execute(toolCallId, params, signal) {
      return callBridge("ask_user_question", toolCallId, params, signal, ASK_TIMEOUT_MS);
    },
  });

  pi.registerTool({
    name: "memory_add",
    label: "Memory",
    description: ${JSON.stringify(MEM_ADD_DESC)},
    promptSnippet: ${JSON.stringify(MEM_ADD_SNIPPET)},
    parameters: Type.Object({
      target: memoryTargetSchema,
      scope: Type.Optional(memoryScopeSchema),
      content: Type.String({ description: "The entry content to append." }),
    }),
    async execute(toolCallId, params, signal) {
      return callBridge("memory_add", toolCallId, params, signal, DEFAULT_TIMEOUT_MS);
    },
  });

  pi.registerTool({
    name: "memory_replace",
    label: "Memory",
    description: ${JSON.stringify(MEM_REPLACE_DESC)},
    promptSnippet: ${JSON.stringify(MEM_REPLACE_SNIPPET)},
    parameters: Type.Object({
      target: memoryTargetSchema,
      scope: Type.Optional(memoryScopeSchema),
      oldText: Type.String({ description: "A short substring uniquely identifying the entry to replace." }),
      newContent: Type.String({ description: "The replacement entry content." }),
    }),
    async execute(toolCallId, params, signal) {
      return callBridge("memory_replace", toolCallId, params, signal, DEFAULT_TIMEOUT_MS);
    },
  });

  pi.registerTool({
    name: "memory_remove",
    label: "Memory",
    description: ${JSON.stringify(MEM_REMOVE_DESC)},
    promptSnippet: ${JSON.stringify(MEM_REMOVE_SNIPPET)},
    parameters: Type.Object({
      target: memoryTargetSchema,
      scope: Type.Optional(memoryScopeSchema),
      oldText: Type.String({ description: "A short substring uniquely identifying the entry to remove." }),
    }),
    async execute(toolCallId, params, signal) {
      return callBridge("memory_remove", toolCallId, params, signal, DEFAULT_TIMEOUT_MS);
    },
  });

  pi.registerTool({
    name: "memory_read",
    label: "Memory",
    description: ${JSON.stringify(MEM_READ_DESC)},
    promptSnippet: ${JSON.stringify(MEM_READ_SNIPPET)},
    parameters: Type.Object({
      target: memoryTargetSchema,
      scope: Type.Optional(memoryScopeSchema),
    }),
    async execute(toolCallId, params, signal) {
      return callBridge("memory_read", toolCallId, params, signal, DEFAULT_TIMEOUT_MS);
    },
  });

  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    description: ${JSON.stringify(DELEGATE_DESCRIPTION)},
    parameters: DelegateParamsSchema,
    async execute(toolCallId, params, signal) {
      return callBridge("delegate", toolCallId, params, signal, DEFAULT_TIMEOUT_MS);
    },
  });

  pi.registerTool({
    name: "fleet",
    label: "Fleet",
    description: ${JSON.stringify(FLEET_DESCRIPTION)},
    parameters: FleetParamsSchema,
    async execute(toolCallId, params, signal) {
      return callBridge("fleet", toolCallId, params, signal, DEFAULT_TIMEOUT_MS);
    },
  });
}
`;
}

/**
 * 生成 bridge 扩展文件到 GENERATED_DIR/hiagent-bridge.ts（每次覆盖写，幂等）。
 * 返回文件路径，供 kernel spawn pi 时经 -e 注入。
 */
export async function ensureBridgeExtension(): Promise<string> {
  await mkdir(GENERATED_DIR, { recursive: true });
  await writeFile(BRIDGE_EXTENSION_PATH, generateBridgeExtension(), "utf8");
  return BRIDGE_EXTENSION_PATH;
}
