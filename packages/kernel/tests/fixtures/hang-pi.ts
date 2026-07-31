// hang-pi.ts — 测试用假 pi rpc 进程：prompt 后只回 response，永不发 agent_settled。
// 模拟子代理卡死场景（进程存活但不 settle），用于测 runSubagentAgent 的 settled 超时。

let buffer = "";

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function handle(cmd: any): void {
  switch (cmd.type) {
    case "prompt":
      // 只回 prompt 响应 + agent_start，但永不发 agent_settled（模拟 hang）
      emit({ id: cmd.id, type: "response", command: "prompt", success: true });
      emit({ type: "agent_start" });
      // 故意不发 message_end / agent_end / agent_settled → settled 永远不 resolve
      break;
    case "get_last_assistant_text":
      emit({ id: cmd.id, type: "response", command: "get_last_assistant_text", success: true, data: { text: "" } });
      break;
    case "get_session_stats":
      emit({ id: cmd.id, type: "response", command: "get_session_stats", success: true, data: {} });
      break;
    default:
      emit({ id: cmd.id, type: "response", command: cmd.type, success: true, data: {} });
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
      console.error("[hang-pi] 解析失败:", err);
    }
  }
});

// 保持进程存活（不退出），模拟真实卡死的子代理
process.stdin.on("end", () => { /* stdin 关闭也不退出，靠 dispose kill */ });
