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
	return { main: { agentName: "agent", message }, toolResults: new Map() };
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
// 「最终回复」外置规则：仅当最后一段 text 之后不存在任何过程段（thinking/toolCall）
// 时才外置为「最终回复」（渲染在过程块之后）；若其后还有过程段（如 fleet 被中断后
// AI 未再输出文本，过渡语紧跟工具卡片），该 text 并入过程流按原序内联渲染。
// ---------------------------------------------------------------------------

// 带 toolResult 的 assistant 行：toolResults 以 toolCallId 挂 Map（同 preprocess 挂载方式）
function assistantRow(message: any, toolResults: Array<[string, any]>) {
	return {
		main: { agentName: "agent", message },
		toolResults: new Map(toolResults),
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

test("最后 text 段之后仍有过程段（中断后无最终回复）：text 不外置、按原序渲染在工具卡之前", () => {
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
	// 轮级折叠生效（含过程卡），展开查看过程流
	fireEvent.click(screen.getByTestId("turn-summary"));
	// 全行只有一个 text-bubble，且位于过程块（turn-summary）内部 → 未外置
	const bubbles = container.querySelectorAll('[data-testid="text-bubble"]');
	expect(bubbles.length).toBe(1);
	const summaryRoot = screen.getByTestId("turn-summary").parentElement!;
	expect(summaryRoot.contains(bubbles[0])).toBe(true);
	// 原序内联：text-bubble 渲染在工具卡片之前（不外置到卡片之后）
	expect(
		bubbles[0].compareDocumentPosition(screen.getByTestId("toolcall-call-1")) &
			Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
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
	// 展开过程块后，过程流内不含 text 段（只有过程卡）
	fireEvent.click(screen.getByTestId("turn-summary"));
	expect(
		summaryRoot.lastElementChild!.querySelectorAll('[data-testid="text-bubble"]')
			.length,
	).toBe(0);
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
