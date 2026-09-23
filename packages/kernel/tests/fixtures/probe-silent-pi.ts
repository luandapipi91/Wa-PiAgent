// probe-silent-pi.ts — 测试用假 pi rpc 进程：prompt 后回 response + agent_start，
// 之后**不回应 get_state**（模拟 pi 进程还活着、但事件循环/协议通道已经僵死），
// 其余命令（get_last_assistant_text / get_session_stats 等）照常回。
// 用于验证「探活不设超时：不回包既不算成功也不算失败 → 不判死」（判死交给事件兜底）。

let buffer = "";

function emit(obj: unknown): void {
	process.stdout.write(JSON.stringify(obj) + "\n");
}

function handle(cmd: any): void {
	switch (cmd.type) {
		case "prompt":
			emit({ id: cmd.id, type: "response", command: "prompt", success: true });
			// 发一条事件让子代理进入「已开始活动」状态（探活据此启动）
			emit({ type: "agent_start" });
			break;
		case "get_state":
			// 故意不回：进程仍在跑，但协议通道不再有响应
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
			console.error("[probe-silent-pi] 解析失败:", err);
		}
	}
});

// 保持进程存活（不退出），靠 dispose kill
process.stdin.on("end", () => {
	/* 不退出 */
});
