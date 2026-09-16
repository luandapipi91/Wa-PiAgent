// collectTurns 单元测试：覆盖「导出会话→复制图片」取消息的多种数据形态。
// 重点回归：流式期间 store 未 compact 的 thinking+text 拆分消息，
// 不能因为 uptoTimestamp=回合首块时间而丢掉 text 正文。
import { describe, it, expect } from "bun:test";
import { collectTurns } from "../src/util/export-chat-image";
import type { SessionMessage } from "@wa-pi/shared";

function msg(
	role: "user" | "assistant",
	timestamp: number,
	text: string,
	agentName = "coder",
): SessionMessage {
	return {
		agentName,
		message: {
			role,
			timestamp,
			content: [{ type: "text", text }],
		} as any,
	};
}

describe("collectTurns", () => {
	it("单轮：取到当条 user + assistant", () => {
		const ms = [
			msg("user", 100, "你好"),
			msg("assistant", 200, "你好！"),
		];
		const turns = collectTurns(ms, 200, 5);
		expect(turns).toHaveLength(1);
		expect(turns[0].user).toBe("你好");
		expect(turns[0].assistant).toBe("你好！");
	});

	it("多轮 + 默认1轮：取最后一轮", () => {
		const ms = [
			msg("user", 100, "第一轮问题"),
			msg("assistant", 1000, "第一轮回复"),
			msg("user", 2000, "第二轮问题"),
			msg("assistant", 3000, "第二轮回复"),
			msg("user", 4000, "第三轮问题"),
			msg("assistant", 5000, "第三轮回复（最新）"),
		];
		const turns = collectTurns(ms, 5000, 1);
		expect(turns).toHaveLength(1);
		expect(turns[0].assistant).toBe("第三轮回复（最新）");
		expect(turns[0].user).toBe("第三轮问题");
	});

	it("多轮 + 取3轮：时间正序返回", () => {
		const ms = [
			msg("user", 100, "Q1"),
			msg("assistant", 200, "A1"),
			msg("user", 300, "Q2"),
			msg("assistant", 400, "A2"),
			msg("user", 500, "Q3"),
			msg("assistant", 600, "A3"),
		];
		const turns = collectTurns(ms, 600, 3);
		expect(turns.map((t) => t.assistant)).toEqual(["A1", "A2", "A3"]);
	});

	// ===== 回归：本 bug 的核心场景 =====
	it("流式未 compact：thinking+text 拆分，uptoTimestamp=回合首块时间，必须取到正文而非只有 thinking", () => {
		// store 在流式期间不 compact（append 不合并），同一回合 assistant 是多条：
		// thinking 块(ts=4500) + text 正文块(ts=5000)，timestamp 不同。
		// 用户点最后一条回复导出 → uptoTimestamp 来自渲染合并行（保留首块 ts=4500）。
		const ms = [
			msg("user", 100, "第一轮问题"),
			msg("assistant", 1000, "thinking 1"),
			msg("assistant", 1500, "第一轮回复正文"),
			msg("user", 2000, "第二轮问题"),
			msg("assistant", 3000, "thinking 2"),
			msg("assistant", 3500, "第二轮回复正文"),
			msg("user", 4000, "第三轮问题"),
			msg("assistant", 4500, "thinking 3"),
			msg("assistant", 5000, "第三轮回复正文（最新）"),
		];
		const turns = collectTurns(ms, 4500, 1);
		expect(turns).toHaveLength(1);
		// 关键断言：必须包含正文；修复前会丢失正文只剩 "thinking 3"
		expect(turns[0].assistant).toContain("第三轮回复正文（最新）");
		expect(turns[0].user).toBe("第三轮问题");
	});

	it("uptoTimestamp 之后的消息不参与（未来消息过滤）", () => {
		const ms = [
			msg("user", 100, "Q1"),
			msg("assistant", 200, "A1"),
			msg("user", 300, "Q2"),
			msg("assistant", 400, "A2"),
		];
		// 只取到 ts<=200，第二轮(400)不参与
		const turns = collectTurns(ms, 200, 5);
		expect(turns).toHaveLength(1);
		expect(turns[0].assistant).toBe("A1");
	});

	it("uptoTimestamp 落在回合中间：整回合保留（不被拆散）", () => {
		// 同回合 thinking(ts=200)+text(ts=300)，uptoTimestamp=250 落在中间。
		// 按回合首块语义，整回合都 ≤ 250 不成立（首块 200≤250 ✓），
		// 所以整回合保留——这是修复后的正确语义。
		const ms = [
			msg("user", 100, "Q1"),
			msg("assistant", 200, "thinking"),
			msg("assistant", 300, "正文"),
		];
		const turns = collectTurns(ms, 250, 5);
		expect(turns).toHaveLength(1);
		expect(turns[0].assistant).toContain("正文");
	});

	it("无文本回复的纯过程轮跳过", () => {
		const ms = [
			msg("user", 100, "Q1"),
			msg("assistant", 200, "   "), // 纯空白，视为无文字
			msg("assistant", 300, "真正的回复"),
		];
		const turns = collectTurns(ms, 300, 5);
		expect(turns).toHaveLength(1);
		expect(turns[0].assistant).toBe("真正的回复");
	});

	it("extension 斜杠命令（assistant 前无 user）：user 置空仍收集该轮", () => {
		// pi 拦截执行 extension 命令不产生 user 消息，聊天列表只有 assistant 回复。
		// 该轮必须可导出（user 为空），否则导出按钮会置灰。
		const ms = [msg("assistant", 100, "命令执行结果")];
		const turns = collectTurns(ms, 100, 5);
		expect(turns).toHaveLength(1);
		expect(turns[0].user).toBe("");
		expect(turns[0].assistant).toBe("命令执行结果");
	});

	it("空消息返回空", () => {
		expect(collectTurns([], 100, 5)).toEqual([]);
	});
});
