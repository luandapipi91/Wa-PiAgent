// hiagent-bridge.extension.ts —— HiAgent RPC 模式宿主工具桥（静态扩展文件）
//
// 本文件由 ensureBridgeExtension() 复制到 GENERATED_DIR/hiagent-bridge.ts，
// Pi 进程经 -e 加载。所有工具的 execute 经 HTTP 回调 kernel 的 /bridge/tool 端点。
//
// 工具文案与 Schema 来源于 @hiagent/shared/tool-schemas.ts（复制到同目录下）。
// 不再动态生成——文案统一来源，kernel 侧与 bridge 侧引用同一份定义。

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  ASK_DESCRIPTION,
  ASK_PROMPT_GUIDELINES,
  AskParamsSchema,
  MEM_TARGET_DESC,
  MEM_SCOPE_DESC,
  MEM_ADD_DESC,
  MEM_ADD_SNIPPET,
  MEM_REPLACE_DESC,
  MEM_REPLACE_SNIPPET,
  MEM_REMOVE_DESC,
  MEM_REMOVE_SNIPPET,
  MEM_READ_DESC,
  MEM_READ_SNIPPET,
  MemoryTargetSchema,
  MemoryScopeSchema,
  DELEGATE_DESCRIPTION,
  DelegateParamsSchema,
  FLEET_DESCRIPTION,
  FleetParamsSchema,
} from "./tool-schemas.ts";

// =========================================================================
// kernel spawn pi 时注入的三个环境变量
// =========================================================================

const BRIDGE_URL = process.env.HIAGENT_BRIDGE_URL;
const BRIDGE_TOKEN = process.env.HIAGENT_BRIDGE_TOKEN;
const BRIDGE_SESSION_ID = process.env.HIAGENT_SESSION_ID;

const DEFAULT_TIMEOUT_MS = 60_000; // 普通工具 60s
const ASK_TIMEOUT_MS = 600_000; // ask 等用户回答，放宽到 10 分钟

type BridgeToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: unknown;
};

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
  timeoutMs?: number,
): Promise<BridgeToolResult> {
  const missing = missingEnvError();
  if (missing) return failResult(missing, "missing_env");
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (timeoutMs !== undefined && timeoutMs > 0) {
    timer = setTimeout(
      () => ctrl.abort(new Error("bridge 调用超时 (" + timeoutMs + "ms)")),
      timeoutMs,
    );
  }
  const onToolAbort = () =>
    ctrl.abort((signal && signal.reason) || new Error("aborted"));
  if (signal) {
    if (signal.aborted) onToolAbort();
    else signal.addEventListener("abort", onToolAbort, { once: true });
  }
  try {
    const res = await fetch(BRIDGE_URL + "/bridge/tool", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: BRIDGE_TOKEN,
        sessionId: BRIDGE_SESSION_ID,
        toolCallId,
        tool,
        params,
      }),
      signal: ctrl.signal,
    });
    const data = (await res.json().catch(() => null)) as any;
    if (!res.ok) {
      const errMsg =
        data && typeof data.error === "string"
          ? data.error
          : "http_" + res.status;
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
    if (timer !== undefined) clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onToolAbort);
  }
}

// =========================================================================
// 工具注册
// =========================================================================

export default function (pi: ExtensionAPI) {
  // 强制 web_search 默认参数：不弹 curator、每次 8 条结果
  pi.on("tool_call", (event) => {
    if ((event as any).toolName === "web_search") {
      const input = (event as any).input as Record<string, unknown>;
      console.log("[hiagent-bridge] web_search tool_call 拦截, 原始 input:", JSON.stringify(input));
      if (input.numResults === undefined) input.numResults = 8;
      if (input.workflow === undefined) input.workflow = "auto-summary";
      console.log("[hiagent-bridge] web_search tool_call 拦截, 修改后 input:", JSON.stringify(input));
    }
  });

  pi.registerTool({
    name: "ask_user_question",
    label: "Ask User",
    description: ASK_DESCRIPTION,
    promptGuidelines: ASK_PROMPT_GUIDELINES,
    parameters: AskParamsSchema,
    async execute(toolCallId, params, signal) {
      return callBridge(
        "ask_user_question",
        toolCallId,
        params,
        signal,
        ASK_TIMEOUT_MS,
      );
    },
  });

  pi.registerTool({
    name: "memory_add",
    label: "Memory",
    description: MEM_ADD_DESC,
    promptSnippet: MEM_ADD_SNIPPET,
    parameters: Type.Object({
      target: MemoryTargetSchema,
      scope: Type.Optional(MemoryScopeSchema),
      content: Type.String({ description: "The entry content to append." }),
    }),
    async execute(toolCallId, params, signal) {
      return callBridge("memory_add", toolCallId, params, signal, DEFAULT_TIMEOUT_MS);
    },
  });

  pi.registerTool({
    name: "memory_replace",
    label: "Memory",
    description: MEM_REPLACE_DESC,
    promptSnippet: MEM_REPLACE_SNIPPET,
    parameters: Type.Object({
      target: MemoryTargetSchema,
      scope: Type.Optional(MemoryScopeSchema),
      oldText: Type.String({
        description: "A short substring uniquely identifying the entry to replace.",
      }),
      newContent: Type.String({
        description: "The replacement entry content.",
      }),
    }),
    async execute(toolCallId, params, signal) {
      return callBridge("memory_replace", toolCallId, params, signal, DEFAULT_TIMEOUT_MS);
    },
  });

  pi.registerTool({
    name: "memory_remove",
    label: "Memory",
    description: MEM_REMOVE_DESC,
    promptSnippet: MEM_REMOVE_SNIPPET,
    parameters: Type.Object({
      target: MemoryTargetSchema,
      scope: Type.Optional(MemoryScopeSchema),
      oldText: Type.String({
        description: "A short substring uniquely identifying the entry to remove.",
      }),
    }),
    async execute(toolCallId, params, signal) {
      return callBridge("memory_remove", toolCallId, params, signal, DEFAULT_TIMEOUT_MS);
    },
  });

  pi.registerTool({
    name: "memory_read",
    label: "Memory",
    description: MEM_READ_DESC,
    promptSnippet: MEM_READ_SNIPPET,
    parameters: Type.Object({
      target: MemoryTargetSchema,
      scope: Type.Optional(MemoryScopeSchema),
    }),
    async execute(toolCallId, params, signal) {
      return callBridge("memory_read", toolCallId, params, signal, DEFAULT_TIMEOUT_MS);
    },
  });

  pi.registerTool({
    name: "delegate",
    label: "Delegate",
    description: DELEGATE_DESCRIPTION,
    parameters: DelegateParamsSchema,
    async execute(toolCallId, params, signal) {
      return callBridge("delegate", toolCallId, params, signal);
    },
  });

  pi.registerTool({
    name: "fleet",
    label: "Fleet",
    description: FLEET_DESCRIPTION,
    parameters: FleetParamsSchema,
    async execute(toolCallId, params, signal) {
      return callBridge("fleet", toolCallId, params, signal);
    },
  });
}
