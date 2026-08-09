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

// 回归：404 错误页（HTML）不得误分类为 transient。
// 根因：错误页 HTML 含任意三位数（如像素宽度 "563"），旧的宽泛正则 5\d\d
// 会误匹配 → 错误归类成 transient，导致确定性失败被当成"网络重试"，
// 既显示误导文案（模型连接异常/检查网络）又卡在 loading 不结束。
test("classifySdkError: 404 HTML 错误页 → fatal（不得误分类 transient）", () => {
  // 真实抓取的 opencode-go provider 404 响应（含 width="563" 等三位数）
  const html404 = '404 <!DOCTYPE html><html lang="en" dir="ltr"><head><meta charset="utf-8">' +
    '<div width="563" style="height:563px"><span id="err-563">server error</span></div></html>';
  expect(classifySdkError(errEvent(html404))?.category).toBe("fatal");
});

test("classifySdkError: 明文 500 → transient（真实 5xx 仍应识别）", () => {
  expect(classifySdkError(errEvent("HTTP 500 Internal Server Error"))?.category).toBe("transient");
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

// ========== HTML 错误页清洗 ==========
//
// 背景：provider baseUrl 错误时返回整页 HTML（如 404 网站页面），
// 原样贴到会话流不可读（数千字符）。sanitizeErrorMessage 提取
// HTTP 状态码映射到预设的通用提示文案。

test("classifySdkError: 404 HTML 错误页 message 映射到通用提示", () => {
  const html = '404 <!DOCTYPE html><html lang="en"><head><meta charset="utf-8">' +
    '<title data-sm="x">Not Found | opencode</title></head><body><div width="563">server error</div></body></html>';
  const result = classifySdkError(errEvent(html));
  expect(result?.category).toBe("fatal");
  // 清洗后映射到预设枚举，不含 HTML 标签
  expect(result?.message).toBe("接口不存在（404），请检查 Provider 的 baseUrl 或模型 ID");
  expect(result?.message).not.toContain("<");
  expect(result!.message.length).toBeLessThan(html.length);
});

test("classifySdkError: 503 HTML 错误页映射到通用提示", () => {
  const html = '503 <!DOCTYPE html><html><body>maintenance</body></html>';
  expect(classifySdkError(errEvent(html))?.message).toBe("服务不可用（503），请稍后重试");
});

test("classifySdkError: 401 HTML 错误页映射到鉴权提示", () => {
  const html = '401 <!DOCTYPE html><html><body>unauthorized</body></html>';
  expect(classifySdkError(errEvent(html))?.message).toBe("鉴权失败（401），请检查 API Key");
});

test("classifySdkError: 正常错误文案（非 HTML）原样保留", () => {
  expect(classifySdkError(errEvent("Connection error."))?.message).toBe("Connection error.");
  expect(classifySdkError(errEvent('Model "foo" not found'))?.message).toBe('Model "foo" not found');
});

test("classifySdkError: HTML 但无法识别状态码 → 兜底文案", () => {
  // HTML 中无可识别的三位数状态码
  const html = '<!DOCTYPE html><html><body>weird error</body></html>';
  const result = classifySdkError(errEvent(html));
  expect(result?.message).toBe("模型调用失败，请检查模型与 Provider 配置（模型不可用或鉴权失败）");
});

// 未枚举的 HTTP 状态码按段位给通用提示（带上具体状态码供排查）
test("classifySdkError: 未枚举 4xx（422）→ 请求错误通用提示", () => {
  const html = '422 <!DOCTYPE html><html><body>Unprocessable Entity</body></html>';
  expect(classifySdkError(errEvent(html))?.message).toBe("请求错误（422），请检查请求参数或 Provider 配置");
});

test("classifySdkError: 未枚举 5xx（507）→ 服务端错误通用提示", () => {
  const html = '507 <!DOCTYPE html><html><body>Insufficient Storage</body></html>';
  expect(classifySdkError(errEvent(html))?.message).toBe("服务端错误（507），请稍后重试");
});

test("classifySdkError: 451 Legal Redirect → 4xx 通用提示", () => {
  const html = '451 <!DOCTYPE html><html><body>Unavailable For Legal Reasons</body></html>';
  expect(classifySdkError(errEvent(html))?.message).toBe("请求错误（451），请检查请求参数或 Provider 配置");
});

test("extractSdkErrorMessage: 404 HTML 映射到通用提示", () => {
  const html = '404 <!DOCTYPE html><html><head><title>Not Found</title></head></html>';
  expect(extractSdkErrorMessage(errEvent(html))).toBe("接口不存在（404），请检查 Provider 的 baseUrl 或模型 ID");
});

test("isTransientErrorMessage: Connection error. → true", () => {
  expect(isTransientErrorMessage("Connection error.")).toBe(true);
});

test("isTransientErrorMessage: insufficient_quota → false", () => {
  expect(isTransientErrorMessage("insufficient_quota")).toBe(false);
});

test("isTransientErrorMessage: 空字符串 → false", () => {
  expect(isTransientErrorMessage("")).toBe(false);
});
