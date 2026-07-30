import { test, expect } from "bun:test";
import type { SDKEvent } from "@wa-pi/shared";
import { extractSdkErrorMessage, classifySdkError, isTransientErrorMessage } from "../src/sdk-errors";

// 根因回归：SDK 把 provider 运行时错误（不可用模型 / 鉴权失败 / 网络）
// 编码成 message_end{stopReason:"error", errorMessage} 事件而非抛异常。
// 该助手函数负责从中提取可展示的错误文案，供 kernel 翻译成 {type:"error"} 广播。

test("message_end 带 stopReason:error + errorMessage → 返回 errorMessage", () => {
  const event: SDKEvent = {
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      model: "slug/231223",
      stopReason: "error",
      errorMessage: 'Model "231223" not found',
      timestamp: 1,
    } as any,
  };
  expect(extractSdkErrorMessage(event)).toBe('Model "231223" not found');
});

test("message_end 带 stopReason:error 但无 errorMessage → 返回兜底文案", () => {
  const event: SDKEvent = {
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      model: "slug/231223",
      stopReason: "error",
      timestamp: 1,
    } as any,
  };
  const msg = extractSdkErrorMessage(event);
  expect(msg).not.toBeNull();
  expect(typeof msg).toBe("string");
  expect(msg!.length).toBeGreaterThan(0);
});

test("正常结束 stopReason:stop → null（不误报）", () => {
  const event: SDKEvent = {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hi" }],
      model: "m",
      stopReason: "stop",
      timestamp: 1,
    } as any,
  };
  expect(extractSdkErrorMessage(event)).toBeNull();
});

test("user 角色的 message_end → null", () => {
  const event: SDKEvent = {
    type: "message_end",
    message: { role: "user", content: "hi", timestamp: 1 } as any,
  };
  expect(extractSdkErrorMessage(event)).toBeNull();
});

test("非 message_end 事件 → null", () => {
  const agentStart: SDKEvent = { type: "agent_start" };
  const agentEnd: SDKEvent = { type: "agent_end", messages: [], willRetry: false };
  expect(extractSdkErrorMessage(agentStart)).toBeNull();
  expect(extractSdkErrorMessage(agentEnd)).toBeNull();
});

test("message_start 首帧（即便 stopReason 占位）→ null", () => {
  const event: SDKEvent = {
    type: "message_start",
    message: {
      role: "assistant",
      content: [],
      model: "m",
      stopReason: "stop",
      timestamp: 1,
    } as any,
  };
  expect(extractSdkErrorMessage(event)).toBeNull();
});

// ========== 错误分类（transient / fatal）==========
//
// 背景：网络类错误（Connection error / timeout / fetch failed）是临时性的，
// 适合用状态条提示而非红色会话消息。鉴权失败 / 配额耗尽 / 模型不可用是确定性错误，
// 需保留红色消息提示用户改配置。classifySdkError 负责按文案分类。
// 正则来源：复用 pi-ai dist/utils/retry.js 的语义（该模块未通过 exports 暴露，无法直接 import）。

function errEvent(errorMessage: string): SDKEvent {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      model: "m",
      stopReason: "error",
      errorMessage,
      timestamp: 1,
    } as any,
  };
}

test("classifySdkError: Connection error. → transient（网络临时错误）", () => {
  expect(classifySdkError(errEvent("Connection error."))?.category).toBe("transient");
});

test("classifySdkError: Request timed out. → transient", () => {
  expect(classifySdkError(errEvent("Request timed out."))?.category).toBe("transient");
});

test("classifySdkError: fetch failed → transient", () => {
  expect(classifySdkError(errEvent("fetch failed"))?.category).toBe("transient");
});

test("classifySdkError: socket hang up → transient", () => {
  expect(classifySdkError(errEvent("socket hang up"))?.category).toBe("transient");
});

test("classifySdkError: 503 Service Unavailable → transient（5xx 服务端错误）", () => {
  expect(classifySdkError(errEvent("503 Service Unavailable"))?.category).toBe("transient");
});

test("classifySdkError: rate limit exceeded → transient（限流）", () => {
  expect(classifySdkError(errEvent("rate limit exceeded"))?.category).toBe("transient");
});

test("classifySdkError: insufficient_quota → fatal（配额耗尽，需用户处理）", () => {
  expect(classifySdkError(errEvent("insufficient_quota"))?.category).toBe("fatal");
});

test("classifySdkError: 401 Unauthorized → fatal（鉴权失败）", () => {
  expect(classifySdkError(errEvent("401 Unauthorized"))?.category).toBe("fatal");
});

test("classifySdkError: 403 Forbidden → fatal（鉴权失败）", () => {
  expect(classifySdkError(errEvent("403 Forbidden"))?.category).toBe("fatal");
});

test("classifySdkError: Model not found → fatal（模型不可用）", () => {
  expect(classifySdkError(errEvent('Model "foo" not found'))?.category).toBe("fatal");
});

test("classifySdkError: 未知错误文案 → fatal（保守，保留红色提示）", () => {
  expect(classifySdkError(errEvent("某种未知的奇怪错误"))?.category).toBe("fatal");
});

test("classifySdkError: 正常结束 stopReason:stop → null", () => {
  const event: SDKEvent = {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "hi" }], model: "m", stopReason: "stop", timestamp: 1 } as any,
  };
  expect(classifySdkError(event)).toBeNull();
});

test("classifySdkError: 无 errorMessage 的错误 → fatal + 兜底文案", () => {
  const event: SDKEvent = {
    type: "message_end",
    message: { role: "assistant", content: [], model: "m", stopReason: "error", timestamp: 1 } as any,
  };
  const result = classifySdkError(event);
  expect(result?.category).toBe("fatal");
  expect(result?.message.length).toBeGreaterThan(0);
});

// isTransientErrorMessage：供 session-history 历史回读过滤使用（只传文案字符串）
test("isTransientErrorMessage: Connection error. → true", () => {
  expect(isTransientErrorMessage("Connection error.")).toBe(true);
});

test("isTransientErrorMessage: insufficient_quota → false", () => {
  expect(isTransientErrorMessage("insufficient_quota")).toBe(false);
});

test("isTransientErrorMessage: 空字符串 → false", () => {
  expect(isTransientErrorMessage("")).toBe(false);
});
