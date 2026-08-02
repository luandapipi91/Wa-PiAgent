// SPDX-License-Identifier: MIT
// wa-pi-bridge.extension.ts —— WaPi RPC 模式宿主工具桥（静态扩展文件）
//
// 本文件由 ensureBridgeExtension() 复制到 GENERATED_DIR/wa-pi-bridge.ts，
// Pi 进程经 -e 加载。所有工具的 execute 经 HTTP 回调 kernel 的 /bridge/tool 端点。
//
// 工具文案与 Schema 来源于 @wa-pi/shared/tool-schemas.ts（复制到同目录下）。
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

const BRIDGE_URL = process.env.WA_PI_BRIDGE_URL;
const BRIDGE_TOKEN = process.env.WA_PI_BRIDGE_TOKEN;
const BRIDGE_SESSION_ID = process.env.WA_PI_SESSION_ID;

const DEFAULT_TIMEOUT_MS = 60_000; // 普通工具 60s
const ASK_TIMEOUT_MS = 600_000; // ask 等用户回答，放宽到 10 分钟
const DELEGATE_TIMEOUT_MS = 600_000; // delegate/fleet：10 分钟无任何帧才判死（流式后"无帧"才是真卡死）

type BridgeToolResult = {
  content: Array<{ type: "text"; text: string }>;
  // pi 0.82 起 AgentToolResult.details 为必填（类型层面对齐；运行期 undefined 行为不变）
  details: unknown;
};

function missingEnvError(): string | null {
  if (!BRIDGE_URL || !BRIDGE_TOKEN || !BRIDGE_SESSION_ID) {
    return "bridge 环境变量缺失（WA_PI_BRIDGE_URL / WA_PI_BRIDGE_TOKEN / WA_PI_SESSION_ID）：该工具只在 wa-pi 宿主下可用";
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
  // 默认 60s 空闲兜底：下面 timeout:false 已关掉 Bun 300s 原生硬超时，
  // 若允许省略，未来新增工具忘传时将无任何兜底、永久挂起。传 0 可显式关闭。
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<BridgeToolResult> {
  const missing = missingEnvError();
  if (missing) return failResult(missing, "missing_env");
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // 空闲超时：每收到一个数据块就重置。只有"长时间无任何帧"才判死——
  // 子代理跑得久但持续有进度帧时不应被掐断。timeoutMs <= 0 为显式关闭。
  const armIdleTimer = () => {
    if (timeoutMs <= 0) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(
      () => ctrl.abort(new Error("bridge 空闲超时 (" + timeoutMs + "ms 无任何帧)")),
      timeoutMs,
    );
  };
  armIdleTimer();
  const onToolAbort = () =>
    ctrl.abort((signal && signal.reason) || new Error("aborted"));
  if (signal) {
    if (signal.aborted) onToolAbort();
    else signal.addEventListener("abort", onToolAbort, { once: true });
  }
  try {
    // timeout:false —— Bun 原生 fetch 有 300s 硬超时（TimeoutError "The operation timed out."，
    // code 23），与 signal 无关、无法被 AbortSignal 延长（Bun 1.3.14 实证 ~300,003ms 触发）。
    // 必须关掉它，否则下面 600s 的空闲超时永远轮不到生效。Bun 专属选项，Node/undici 会忽略。
    const init: RequestInit & { timeout?: boolean } = {
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
      timeout: false,
    };
    const res = await fetch(BRIDGE_URL + "/bridge/tool", init);
    // 流式协议：delegate/fleet 返回 NDJSON，逐帧解析 started/progress/ping/final。
    // started/progress/ping 帧仅证明存活（刷新空闲超时），进度已由 kernel SSE 直推前端，
    // 这里只关心 final 帧来组装结果。
    const isStream = (res.headers.get("content-type") ?? "").includes("x-ndjson");
    if (isStream && res.body) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let finalFrame: any = null;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        armIdleTimer(); // 收到数据块 → 刷新空闲超时（有帧即存活）
        buf += dec.decode(value, { stream: true });
        // 按行切分：最后一行可能不完整（无尾随 \n），留到下一轮拼接
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let frame: any;
          try {
            frame = JSON.parse(line);
          } catch {
            // 单行解析失败：跳过坏帧，不打断流
            continue;
          }
          if (frame.type === "final") {
            finalFrame = frame;
            break;
          }
          // started/progress/ping 帧仅证明存活，不消费
        }
        if (finalFrame) break;
      }
      if (finalFrame) {
        if (finalFrame.ok) {
          return {
            content: finalFrame.result.content,
            details: finalFrame.result.details,
          };
        }
        const err = finalFrame.error ?? "unknown";
        return failResult("bridge 调用失败: " + err, err);
      }
      // 流结束但无 final 帧：连接中断
      return failResult(
        "bridge 调用失败: 连接中断（未收到 final 帧）",
        "stream_interrupted",
      );
    }
    // 降级：非流式响应（老 kernel 或 ask/memory），走旧 JSON 解析
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
      return callBridge("delegate", toolCallId, params, signal, DELEGATE_TIMEOUT_MS);
    },
  });

  pi.registerTool({
    name: "fleet",
    label: "Fleet",
    description: FLEET_DESCRIPTION,
    parameters: FleetParamsSchema,
    async execute(toolCallId, params, signal) {
      return callBridge("fleet", toolCallId, params, signal, DELEGATE_TIMEOUT_MS);
    },
  });
}
