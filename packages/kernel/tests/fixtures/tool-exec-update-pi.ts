// tool-exec-update-pi.ts — 测试用假 pi rpc 进程：prompt 后发 tool_execution_start，
// 然后周期性发 tool_execution_update（模拟长运行工具的流式输出，如 bash 命令逐行输出），
// 永不发 end。用于验证「工具执行中持续有事件 = 有进展，不得判死」。

let buffer = "";
let updateTimer: ReturnType<typeof setInterval> | null = null;

function emit(obj: unknown): void {
	process.stdout.write(JSON.stringify(obj) + "\n");
}

function handle(cmd: any): void {
	switch (cmd.type) {
		case "prompt":
			emit({ id: cmd.id, type: "response", command: "prompt", success: true });
			emit({ type: "agent_start" });
			// 进入工具执行：周期性发流式部分结果（如 bash 输出逐行到达），永不 end
			emit({
				type: "tool_execution_start",
				toolCallId: "tc-bash",
				toolName: "bash",
				args: { command: "long-running" },
			});
			updateTimer = setInterval(() => {
				emit({
					type: "tool_execution_update",
					toolCallId: "tc-bash",
					toolName: "bash",
					args: { command: "long-running" },
					partialResult: { output: "line\n" },
				});
			}, 50);
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
			console.error("[tool-exec-update-pi] 解析失败:", err);
		}
	}
});

// 保持进程存活（不退出），靠 dispose kill
process.stdin.on("end", () => {
	/* 不退出 */
});
