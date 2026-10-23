// saw-error-pi.ts — 测试用假 pi rpc 进程：模拟「模型调用中途报错，随后正常收尾」。
//
// 协议行为对齐 pi --mode rpc：prompt 后先正常输出文本，再发一条
// stopReason="error" 的 assistant message_end（runner 据此置 sawError 粘滞位），
// 随后照常发 agent_end / agent_settled 完成收尾。
//
// 用途：验证「模型报错但任务最终跑完」时进度必须落到终态——
// 此前 runner 的 sawError 早退分支不发终态帧，前端 store 会永久停在 running。

let buffer = "";

function emit(obj: unknown): void {
	process.stdout.write(JSON.stringify(obj) + "\n");
}

function handle(cmd: any): void {
	switch (cmd.type) {
		case "prompt":
			emit({ id: cmd.id, type: "response", command: "prompt", success: true });
			emit({ type: "agent_start" });
			emit({
				type: "message_update",
				message: {},
				assistantMessageEvent: { type: "text_delta", delta: `回声:${cmd.message}` },
			});
			// 中途一次模型调用失败（重试前的终态错误）→ runner 置 sawError
			emit({
				type: "message_end",
				message: { role: "assistant", stopReason: "error", content: [] },
			});
			// 之后恢复正常并完成收尾（发 agent_settled）
			emit({
				type: "message_update",
				message: {},
				assistantMessageEvent: { type: "text_delta", delta: "最终答案" },
			});
			emit({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: `回声:${cmd.message}最终答案` }],
				},
			});
			emit({ type: "agent_end", messages: [], willRetry: false });
			emit({ type: "agent_settled" });
			break;
		case "get_last_assistant_text":
			emit({
				id: cmd.id,
				type: "response",
				command: "get_last_assistant_text",
				success: true,
				data: { text: `回声:${cmd.message}最终答案` },
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
			console.error("[saw-error-pi] 解析失败:", err);
		}
	}
});
