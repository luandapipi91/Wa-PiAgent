import { test, expect } from "bun:test";
import type { SDKEvent } from "@hiagent/shared";
import { extractSdkErrorMessage } from "../src/sdk-errors";

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
