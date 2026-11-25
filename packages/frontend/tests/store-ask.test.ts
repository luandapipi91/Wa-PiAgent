import { describe, expect, it, test, beforeEach } from "bun:test";
import {
  buildQuickReply,
  classifyAsk,
  loadDismissedFromStorage,
  selectPendingAsks,
  useDismissedAskStore,
} from "../src/store/ask";
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

// ---- 失效/终结卡片的状态归属：按会话隔离 + 持久化 ----
// 背景：关闭标记曾是全局集合，而 AskDock 每次 pending 变化都用「当前会话」的列表 prune，
// 切到别的会话就把刚关闭的标记删掉；messagesBySession 又不随切页清空，
// 切回来卡片必然复活（用户实测："点取消，切页回来又是这个"）。

describe("失效提问的关闭标记（按会话隔离）", () => {
	beforeEach(() => {
		localStorage.clear();
		useDismissedAskStore.setState({ bySession: {} });
	});

	it("dismiss 只影响本会话：s1 关闭 tc1，s2 的同一 id 不受影响", () => {
		useDismissedAskStore.getState().dismiss("s1", "tc1");
		expect(
			useDismissedAskStore.getState().isDismissed("s1", "tc1"),
		).toBe(true);
		expect(
			useDismissedAskStore.getState().isDismissed("s2", "tc1"),
		).toBe(false);
	});

	it("prune 只清本会话：切到 s2 后 prune 不得误删 s1 的关闭标记（切页复活的回归用例）", () => {
		useDismissedAskStore.getState().dismiss("s1", "tc1");
		// 切到 s2（s2 没有任何 pending ask）→ AskDock 用 s2 的列表 prune
		useDismissedAskStore.getState().prune("s2", []);
		expect(
			useDismissedAskStore.getState().isDismissed("s1", "tc1"),
		).toBe(true);
	});

	it("prune 清掉本会话里已终结的 id，只保留仍 pending 的", () => {
		useDismissedAskStore.getState().dismiss("s1", "tc1");
		useDismissedAskStore.getState().dismiss("s1", "tc2");
		useDismissedAskStore.getState().prune("s1", ["tc2"]);
		expect(
			useDismissedAskStore.getState().isDismissed("s1", "tc1"),
		).toBe(false);
		expect(
			useDismissedAskStore.getState().isDismissed("s1", "tc2"),
		).toBe(true);
	});

	it("关闭标记持久化：整页刷新后仍记得（失效卡片不会因 F5 复活）", () => {
		useDismissedAskStore.getState().dismiss("s1", "tc1");
		useDismissedAskStore.setState({ bySession: {} }); // 模拟刷新后内存清空
		loadDismissedFromStorage();
		expect(
			useDismissedAskStore.getState().isDismissed("s1", "tc1"),
		).toBe(true);
	});
});

describe("classifyAsk：双检状态 → 卡片该用什么形态", () => {
	it("pending → 可回答；answered/cancelled → 收起；查无此问 → 失效只读", () => {
		expect(classifyAsk("pending")).toBe("open");
		expect(classifyAsk("answered")).toBe("closed");
		expect(classifyAsk("cancelled")).toBe("closed");
		expect(classifyAsk(undefined)).toBe("stale");
	});
});
