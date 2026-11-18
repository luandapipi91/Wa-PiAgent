// MessageRow 组件测试：验证"文件修改清单是否显示由 isLastMessage 决定"。
// 回归场景：修复前 isLastMessage 用 i === displayRows.length - 1（整个列表最后一行）；
// 当末尾插入 extension_notify（插件通知）这类 custom 系统消息后，原最后一条 assistant
// 内容消息的 isLastMessage 变 false → 文件修改清单被顶掉。
// 修复后 isLastMessage 指向"最后一条内容消息"（lastContentRowIndex），文件修改清单恢复显示。
// 这里直接渲染 MessageRow，验证同一条内容消息在 isLastMessage=true 时显示文件修改清单、
// isLastMessage=false 时不显示——证明文件修改清单确实以 isLastMessage 为闸门。
import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const fileChanges = [{ path: "/a.ts", before: "x", after: "y" }];

const baseSessionState = {
	messagesBySession: { s1: [] },
	fileChangesBySession: { s1: fileChanges },
} as any;

const useSessionStore = (selector: (s: unknown) => unknown) =>
	selector(baseSessionState);
(useSessionStore as any).getState = () => baseSessionState;
mock.module("../../store/session", () => ({ useSessionStore }));

const useSkillsStore = (selector: (s: unknown) => unknown) =>
	selector({ skills: [] });
mock.module("../../store/skills", () => ({ useSkillsStore }));

const { MessageRow } = await import("../MessageList");

function row(message: any) {
	return {
		main: { agentName: "agent", message },
		toolResults: new Map(),
		srcIndex: 0,
	};
}

const assistantMsg = {
	role: "assistant",
	content: [{ type: "text", text: "这是最终回复" }],
	timestamp: 10,
};

afterEach(() => cleanup());

test("isLastMessage=true 时，最后一条内容消息下显示文件修改清单", () => {
	render(<MessageRow row={row(assistantMsg)} sessionId="s1" isLastMessage />);
	// 展开清单折叠行
	const summary = screen.getByTestId("file-change-summary");
	expect(summary).toBeTruthy();
});

test("isLastMessage=false 时（末尾被插件通知等系统行抢占），不显示文件修改清单", () => {
	render(
		<MessageRow row={row(assistantMsg)} sessionId="s1" isLastMessage={false} />,
	);
	expect(screen.queryByTestId("file-change-summary")).toBeNull();
});

// ---------------------------------------------------------------------------
// 「最终回复」外置规则：取本轮**最后一段 text** 作为最终回复外置（渲染在过程块之后），
// 无论其后是否还有过程段。中断/停止场景下最后一块常是工具调用或思考——若要求
// 「其后无过程段才外置」，整轮将只剩一行摘要、正文全被藏进折叠区（用户反馈的问题）。
// ---------------------------------------------------------------------------

// 带 toolResult 的 assistant 行：toolResults 以 toolCallId 挂 Map（同 preprocess 挂载方式）
function assistantRow(message: any, toolResults: Array<[string, any]>) {
	return {
		main: { agentName: "agent", message },
		toolResults: new Map(toolResults),
		srcIndex: 0,
	};
}

const powershellCall = {
	type: "toolCall",
	id: "call-1",
	name: "powershell",
	arguments: { command: "echo hi" },
};

const powershellResult = {
	role: "toolResult",
	toolCallId: "call-1",
	isError: false,
	// 工具卡渲染结果区需要 content 数组（元素 {type:"text", text}）
	content: [{ type: "text", text: "ok" }],
};

test("中断轮（最后是过程段）：最后一条 text 仍外置为最终回复，位于过程块之后", () => {
	const msg = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "思考中" },
			{ type: "text", text: "重跑同一批长任务…" },
			powershellCall,
		],
		timestamp: 20,
	};
	const { container } = render(
		<MessageRow
			row={assistantRow(msg, [["call-1", powershellResult]])}
			sessionId="s1"
		/>,
	);
	// 未展开过程块，最终回复也直接可见（外置）——中断轮不再只剩一行摘要
	expect(screen.getByText("重跑同一批长任务…")).toBeTruthy();
	// 全行只有这一个 text-bubble，且不在摘要行内部 → 已外置
	const bubbles = container.querySelectorAll('[data-testid="text-bubble"]');
	expect(bubbles.length).toBe(1);
	const summaryRoot = screen.getByTestId("turn-summary").parentElement!;
	expect(summaryRoot.contains(bubbles[0])).toBe(false);
	// 展开过程块后，正文仍只有一份（不重复渲染）
	fireEvent.click(screen.getByTestId("turn-summary"));
	expect(screen.getAllByText("重跑同一批长任务…").length).toBe(1);
});

test("正常顺序 [THINK, CALL, TEXT]：最后 text 外置为最终回复，渲染在过程块之后（回归）", () => {
	const msg = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "思考中" },
			powershellCall,
			{ type: "text", text: "这是最终回复" },
		],
		timestamp: 21,
	};
	const { container } = render(
		<MessageRow
			row={assistantRow(msg, [["call-1", powershellResult]])}
			sessionId="s1"
		/>,
	);
	// 未展开过程块，最终回复也直接可见（外置）
	const bubbles = container.querySelectorAll('[data-testid="text-bubble"]');
	expect(bubbles.length).toBe(1);
	const summaryRoot = screen.getByTestId("turn-summary").parentElement!;
	// 外置：text-bubble 不在过程块内
	expect(summaryRoot.contains(bubbles[0])).toBe(false);
	// text-bubble 在过程块之后
	expect(
		summaryRoot.compareDocumentPosition(bubbles[0]) &
			Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
	// 展开过程块后：按原始时间线渲染全部段，最后那条正文回到它在过程流里的真实位置
	// （2026-11-18 用户反馈：展开后执行顺序被打乱，正文必须留在原位而不是挪到末尾）
	fireEvent.click(screen.getByTestId("turn-summary"));
	const expandedBubbles = summaryRoot.lastElementChild!.querySelectorAll(
		'[data-testid="text-bubble"]',
	);
	expect(expandedBubbles.length).toBe(1);
	// 正文在工具卡之后（原始顺序 THINK → CALL → TEXT）
	expect(
		expandedBubbles[0].compareDocumentPosition(
			screen.getByTestId("toolcall-call-1"),
		) & Node.DOCUMENT_POSITION_PRECEDING,
	).toBeTruthy();
	// 展开态下外置的最终回复不再重复出现
	expect(
		container.querySelectorAll('[data-testid="text-bubble"]').length,
	).toBe(1);
});

test("纯 [TEXT] 单段（无过程卡）：直接渲染最终回复，无过程摘要块（回归）", () => {
	const msg = {
		role: "assistant",
		content: [{ type: "text", text: "直接回复" }],
		timestamp: 22,
	};
	const { container } = render(
		<MessageRow row={assistantRow(msg, [])} sessionId="s1" />,
	);
	expect(
		container.querySelectorAll('[data-testid="text-bubble"]').length,
	).toBe(1);
	expect(screen.queryByTestId("turn-summary")).toBeNull();
});
