// fake-pi.ts — 测试用假 pi rpc 进程：按命令回固定响应与事件。
// 协议行为对齐 pi --mode rpc：\n 分隔 JSONL、id 关联响应、extension_ui_request 子协议。
// 仅用于 rpc-client.test.ts，不模拟任何真实 LLM 行为。

let buffer = "";
let pendingUiResponse: ((resp: any) => void) | null = null;

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function handle(cmd: any): void {
  if (cmd.type === "extension_ui_response") {
    const cb = pendingUiResponse;
    pendingUiResponse = null;
    cb?.(cmd);
    return;
  }
  switch (cmd.type) {
    case "get_state":
      emit({
        id: cmd.id,
        type: "response",
        command: "get_state",
        success: true,
        data: { model: null, thinkingLevel: "medium", isStreaming: false, pendingMessageCount: 0 },
      });
      break;
    case "get_session_stats":
      emit({
        id: cmd.id,
        type: "response",
        command: "get_session_stats",
        success: true,
        data: {
          tokens: { input: 1000, output: 250, cacheRead: 500, cacheWrite: 0, total: 1750 },
          cost: { total: 0.0042 },
        },
      });
      break;
    case "prompt":
      emit({ id: cmd.id, type: "response", command: "prompt", success: true });
      emit({ type: "agent_start" });
      emit({
        type: "message_update",
        message: {},
        assistantMessageEvent: { type: "text_delta", delta: `回声:${cmd.message}` },
      });
      emit({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: `回声:${cmd.message}` }] },
      });
      emit({ type: "agent_end", messages: [], willRetry: false });
      emit({ type: "agent_settled" });
      break;
    case "fail_me":
      emit({ id: cmd.id, type: "response", command: "fail_me", success: false, error: "故意失败" });
      break;
    case "ui_select":
      // 先发 UI 请求，等 extension_ui_response 到达后才回命令响应
      pendingUiResponse = (resp) => {
        emit({ id: cmd.id, type: "response", command: "ui_select", success: true, data: { echo: resp } });
      };
      emit({
        type: "extension_ui_request",
        id: "ui-req-1",
        method: "select",
        title: "选一个",
        options: ["A", "B"],
      });
      break;
    case "ui_notify":
      // fire-and-forget：不应收到 extension_ui_response，直接回命令响应
      emit({ type: "extension_ui_request", id: "ui-req-2", method: "notify", message: "你好" });
      emit({ id: cmd.id, type: "response", command: "ui_notify", success: true });
      break;
    case "unicode":
      // 含 U+2028/U+2029 的字符串：JSON.stringify 不转义这两个字符，
      // 客户端必须只在 \n 处断行（readline 会在这里错误断开）
      emit({ id: cmd.id, type: "response", command: "unicode", success: true, data: { text: "甲 乙 丙" } });
      break;
    case "slow":
      setTimeout(() => {
        emit({ id: cmd.id, type: "response", command: "slow", success: true });
      }, 5000);
      break;
    case "die":
      process.exit(3);
      break;
    default:
      emit({ id: cmd.id, type: "response", command: cmd.type, success: false, error: `未知命令: ${cmd.type}` });
  }
}

process.stdin.on("data", (chunk: Buffer | string) => {
  buffer += chunk.toString();
  for (;;) {
    const idx = buffer.indexOf("\n");
    if (idx === -1) break;
    let line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line));
    } catch (err) {
      console.error("[fake-pi] 解析失败:", err);
    }
  }
});
