// probe-fail-once-pi.ts — 测试用假 pi rpc 进程：prompt 后回 response + agent_start，
// 对**第一次** get_state 回 success:false，之后一律回正常 state。
// 用于验证「探活单次失败即判死」：若还保留连续计数逻辑，第二次探活成功会把计数归零，
// 于是永不判死；单次判定则第一次失败就强杀。

let buffer = "";
let getStateCalls = 0;

function emit(obj: unknown): void {
	process.stdout.write(JSON.stringify(obj) + "\n");
}

function handle(cmd: any): void {
	switch (cmd.type) {
		case "prompt":
			emit({ id: cmd.id, type: "response", command: "prompt", success: true });
			emit({ type: "agent_start" });
			break;
		case "get_state": {
			getStateCalls += 1;
			if (getStateCalls === 1) {
				emit({
					id: cmd.id,
					type: "response",
					command: "get_state",
					success: false,
					error: "transient probe failure",
				});
				break;
			}
			emit({
				id: cmd.id,
				type: "response",
				command: "get_state",
				success: true,
				data: { isStreaming: true, messageCount: 0, pendingMessageCount: 0 },
			});
			break;
		}
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
			console.error("[probe-fail-once-pi] 解析失败:", err);
		}
	}
});

// 保持进程存活（不退出），靠 dispose kill
process.stdin.on("end", () => {
	/* 不退出 */
});
