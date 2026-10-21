// exit-early-pi.ts — 测试用假 pi rpc 进程：prompt 后只回响应 + agent_start，随即以非 0 码退出。
// 模拟子代理进程崩溃 / 被杀（onExit 早于 agent_settled），用于锁 runSubagentAgent 的
// 「子智能体进程异常退出」收尾文案（此时进程退出码不再进对外文案）。

let buffer = "";

function emit(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function handle(cmd: any): void {
  switch (cmd.type) {
    case "prompt":
      emit({ id: cmd.id, type: "response", command: "prompt", success: true });
      emit({ type: "agent_start" });
      // 等 stdout 落到管道（管道写是异步的）再退出，确保 prompt 响应先被读到；
      // agent_settled 永远不发 → 走 onExit 判死路径
      setTimeout(() => process.exit(1), 20);
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
      console.error("[exit-early-pi] 解析失败:", err);
    }
  }
});

// stdin 关闭也不提前退出：退出时机由 prompt 后的计时器决定（保证先收到 prompt 响应）
process.stdin.on("end", () => { /* noop */ });
