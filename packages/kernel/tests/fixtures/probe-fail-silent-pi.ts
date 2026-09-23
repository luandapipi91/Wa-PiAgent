// probe-fail-silent-pi.ts — 测试用假 pi rpc 进程：prompt 后只回 response，
// **不发任何事件**（连 agent_start 都不发），对 get_state 回 success:false。
// 用于验证「探活自子代理启动后立即开始、不等 RPC 事件」：若探活要等事件才启动，
// 这里永远不会判死；启动即探活则连续 3 次失败即判死。

let buffer = "";

function emit(obj: unknown): void {
	process.stdout.write(JSON.stringify(obj) + "\n");
}

function handle(cmd: any): void {
	switch (cmd.type) {
		case "prompt":
			// 只回 response：故意不发 agent_start / message_* 等任何事件
			emit({ id: cmd.id, type: "response", command: "prompt", success: true });
			break;
		case "get_state":
			emit({
				id: cmd.id,
				type: "response",
				command: "get_state",
				success: false,
				error: "probe unavailable",
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
			console.error("[probe-fail-silent-pi] 解析失败:", err);
		}
	}
});

// 保持进程存活（不退出），靠 dispose kill
process.stdin.on("end", () => {
	/* 不退出 */
});
