// event-stream-pi.ts — 测试用假 pi rpc 进程：prompt 后周期性发「同一种类型」的事件，
// 类型由环境变量 FAKE_EVENT_TYPE 指定（进程继承父进程 env）。
// 用于验证「任一官方事件持续到达都算有进展，探活不得判死」——漏掉任何一类事件
// 都会让真实场景（压缩、回合间隙、首 token 等待等）里长时间零刷新的子代理被误杀。
// 永不发 agent_settled（进程保持存活，靠 abort/dispose 结束）。

const eventType = process.env.FAKE_EVENT_TYPE ?? "turn_start";
const EMIT_INTERVAL_MS = 50;

let buffer = "";
let timer: ReturnType<typeof setInterval> | null = null;

function emit(obj: unknown): void {
	process.stdout.write(JSON.stringify(obj) + "\n");
}

/** 事件载荷按类型补齐常见字段（onEvent 里已处理的类型需要它们才走到各自分支） */
function payload() {
	const base: Record<string, unknown> = { type: eventType };
	switch (eventType) {
		case "tool_execution_start":
		case "tool_execution_update":
			return {
				...base,
				toolCallId: "tc-1",
				toolName: "bash",
				args: { command: "long-running" },
				partialResult: { output: "line\n" },
			};
		case "tool_execution_end":
			return { ...base, toolCallId: "tc-1", toolName: "bash", isError: false };
		case "message_update":
			return {
				...base,
				message: {},
				assistantMessageEvent: { type: "text_delta", delta: "." },
			};
		case "message_end":
			return { ...base, message: { role: "assistant", content: [] } };
		case "agent_end":
			return { ...base, messages: [], willRetry: false };
		default:
			return base;
	}
}

function handle(cmd: any): void {
	switch (cmd.type) {
		case "prompt":
			emit({ id: cmd.id, type: "response", command: "prompt", success: true });
			timer = setInterval(() => emit(payload()), EMIT_INTERVAL_MS);
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
			console.error("[event-stream-pi] 解析失败:", err);
		}
	}
});

// 保持进程存活（不退出），靠 abort/dispose kill
process.stdin.on("end", () => {
	if (timer) clearInterval(timer);
});
