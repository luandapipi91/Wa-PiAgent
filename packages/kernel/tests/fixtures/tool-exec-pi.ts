// tool-exec-pi.ts — 测试用假 pi rpc 进程：prompt 后发 tool_execution_start 然后静默，
// 模拟子代理执行工具（如 MCP HTTP 请求）期间无事件输出的合法静默场景。

let buffer = "";

function emit(obj: unknown): void {
	process.stdout.write(JSON.stringify(obj) + "\n");
}

function handle(cmd: any): void {
	switch (cmd.type) {
		case "prompt":
			emit({ id: cmd.id, type: "response", command: "prompt", success: true });
			emit({ type: "agent_start" });
			// 进入工具执行：发 start 后故意不发 end / 任何事件（模拟长 MCP HTTP 等待）
			emit({
				type: "tool_execution_start",
				toolCallId: "tc-mcp",
				toolName: "mcp_http",
				args: { url: "https://example.com/slow" },
			});
			break;
		case "get_last_assistant_text":
			emit({
				id: cmd.id,
				type: "response",
				command: "get_last_assistant_text",
				success: true,
				data: { text: "" },
			});
			break;
		case "get_session_stats":
			emit({
				id: cmd.id,
				type: "response",
				command: "get_session_stats",
				success: true,
				data: {},
			});
			break;
		default:
			emit({
				id: cmd.id,
				type: "response",
				command: cmd.type,
				success: true,
				data: {},
			});
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
			console.error("[tool-exec-pi] 解析失败:", err);
		}
	}
});

// 保持进程存活（不退出），靠 dispose kill
process.stdin.on("end", () => {
	/* 不退出 */
});
