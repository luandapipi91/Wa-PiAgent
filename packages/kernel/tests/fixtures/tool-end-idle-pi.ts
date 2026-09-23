// tool-end-idle-pi.ts — 测试用假 pi rpc 进程：prompt 后发 agent_start →
// tool_execution_start →（100ms）tool_execution_end → 永久静默。
// 用于锁定「工具结束后探活窗口必须回落到基础窗口」：tool_execution_end 要先复位
// toolRunning 再刷新计时，否则窗口会停在 20 分钟的工具窗口上、静默挂死迟迟不判。

let buffer = "";
let timer: ReturnType<typeof setTimeout> | null = null;

function emit(obj: unknown): void {
	process.stdout.write(JSON.stringify(obj) + "\n");
}

function handle(cmd: any): void {
	switch (cmd.type) {
		case "prompt":
			emit({ id: cmd.id, type: "response", command: "prompt", success: true });
			emit({ type: "agent_start" });
			emit({
				type: "tool_execution_start",
				toolCallId: "tc-1",
				toolName: "bash",
				args: { command: "quick" },
			});
			timer = setTimeout(() => {
				emit({
					type: "tool_execution_end",
					toolCallId: "tc-1",
					toolName: "bash",
					isError: false,
				});
				// 之后永久静默（不发 agent_settled）
			}, 100);
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
			console.error("[tool-end-idle-pi] 解析失败:", err);
		}
	}
});

process.stdin.on("end", () => {
	if (timer) clearTimeout(timer);
});
