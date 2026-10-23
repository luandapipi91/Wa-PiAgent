// aborted-tools-pi.ts — 测试用假 pi rpc 进程：prompt 后同步发 3 个工具事件
//（1 成功 / 1 失败 / 1 停在执行中）+ 一段文本输出，然后永久静默（永不 settle）。
// abort 命令只回 success、进程保持存活，模拟「卡在不可中断工具里」的子代理——
// 用于测中止 / 探活超时后的部分进度保留（工具统计 + 摘录条目 + 输出片段）。

let buffer = "";

function emit(obj: unknown): void {
	process.stdout.write(JSON.stringify(obj) + "\n");
}

function handle(cmd: any): void {
	switch (cmd.type) {
		case "prompt":
			emit({ id: cmd.id, type: "response", command: "prompt", success: true });
			emit({ type: "agent_start" });
			// 工具 1：bash 成功
			emit({
				type: "tool_execution_start",
				toolCallId: "tc-1",
				toolName: "bash",
				args: {},
			});
			emit({
				type: "tool_execution_end",
				toolCallId: "tc-1",
				toolName: "bash",
				isError: false,
				// 工具产出留存（对象形状：含 content 数组，同 pi 工具结果）——
				// 验证 result 提取 + 部分进度摘录条目
				result: {
					content: [{ type: "text", text: "已定位到入口文件 src/main.ts" }],
				},
			});
			// 工具 2：read 失败
			emit({
				type: "tool_execution_start",
				toolCallId: "tc-2",
				toolName: "read",
				args: {},
			});
			emit({
				type: "tool_execution_end",
				toolCallId: "tc-2",
				toolName: "read",
				isError: true,
			});
			// 工具 3：write 执行中被中止（永远停在 running）
			emit({
				type: "tool_execution_start",
				toolCallId: "tc-3",
				toolName: "write",
				args: {},
			});
			// 部分文本输出（部分进度段的「最后输出片段」来源）
			emit({
				type: "message_update",
				assistantMessageEvent: {
					type: "text_delta",
					delta: "已定位到问题文件 src/app.ts 第 42 行",
				},
			});
			// 之后永久静默：不发 message_end / agent_end / agent_settled
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
			console.error("[aborted-tools-pi] 解析失败:", err);
		}
	}
});

// 保持进程存活（不退出），靠 dispose kill
process.stdin.on("end", () => {
	/* 不退出 */
});
