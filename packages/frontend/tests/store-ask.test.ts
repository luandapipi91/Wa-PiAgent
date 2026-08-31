import { describe, expect, it, test } from "bun:test";
import { buildQuickReply, selectPendingAsks } from "../src/store/ask";
import type { AskParams, SessionMessage } from "@wa-pi/shared";

function assistantMsg(toolCalls: any[], timestamp = 1): SessionMessage {
  return { message: { role: "assistant", content: toolCalls, model: "m", stopReason: "tool_use", timestamp } as any, agentName: "dev" };
}
function toolResultMsg(toolCallId: string, timestamp = 2): SessionMessage {
  return { message: { role: "toolResult", toolCallId, toolName: "ask_user_question", content: [{ type: "text", text: "ok" }], isError: false, timestamp } as any, agentName: "dev" };
}

const askCall = { type: "toolCall", id: "tc1", name: "ask_user_question", arguments: { questions: [{ question: "Q?", header: "h", options: [{ label: "A", description: "x" }, { label: "B", description: "y" }] }] } };

test("selectPendingAsks: 找出无 result 的 ask 调用", () => {
  const msgs = [assistantMsg([askCall])];
  const pending = selectPendingAsks(msgs);
  expect(pending).toHaveLength(1);
  expect(pending[0].toolCallId).toBe("tc1");
  expect(pending[0].params.questions).toHaveLength(1);
});

test("selectPendingAsks: 有 result 的 ask 不算 pending", () => {
  const msgs = [assistantMsg([askCall]), toolResultMsg("tc1")];
  expect(selectPendingAsks(msgs)).toHaveLength(0);
});

test("selectPendingAsks: 多个 pending；忽略非 ask 的 toolCall", () => {
  const msgs = [assistantMsg([
    askCall,
    { type: "toolCall", id: "tc2", name: "read", arguments: {} },
    { type: "toolCall", id: "tc3", name: "ask_user_question", arguments: { questions: [{ question: "Q2?", header: "h", options: [{ label: "A", description: "x" }, { label: "B", description: "y" }] }] } },
  ])];
  const pending = selectPendingAsks(msgs);
  expect(pending.map(p => p.toolCallId).sort()).toEqual(["tc1", "tc3"]);
});

describe("buildQuickReply", () => {
	const params2: AskParams = {
		questions: [
			{
				question: "优先级?",
				header: "h",
				options: [
					{ label: "高", description: "x" },
					{ label: "低", description: "y" },
				],
			},
			{
				question: "多选?",
				header: "h",
				multiSelect: true,
				options: [
					{ label: "A", description: "x" },
					{ label: "B", description: "y" },
				],
			},
		],
	};

	it("全部问题都选中 → 生成完整 replies", () => {
		const reply = buildQuickReply(params2, {
			0: new Set(["高"]),
			1: new Set(["A", "B"]),
		});
		expect(reply).toEqual({
			replies: [
				{ questionIndex: 0, selected: ["高"] },
				{ questionIndex: 1, selected: ["A", "B"] },
			],
		});
	});

	it("任一问题未选中 → 返回 null（不可提交）", () => {
		const reply = buildQuickReply(params2, { 0: new Set(["高"]) });
		expect(reply).toBeNull();
	});

	it("空选择集 → 返回 null", () => {
		const reply = buildQuickReply(params2, {});
		expect(reply).toBeNull();
	});
});
