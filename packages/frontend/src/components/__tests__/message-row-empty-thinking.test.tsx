// 「空白思考卡」回归：真实会话数据里存在 thinking 正文为空的 thinking 块
// （pi 侧产生，常带 thinkingSignature 但无文本；实测近期会话占比 9~15%）。
// 缺陷现象（用户报告「空的思考」）：空块与正文块同样入场，渲染成一张标题「思考过程」
// 但正文全空的卡片。契约：空正文的 thinking 块不进入渲染流（与空 text 块同规则）。
import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

const baseSessionState = {
	messagesBySession: { s1: [] },
	fileChangesBySession: {},
} as any;

const useSessionStore = (selector: (s: unknown) => unknown) =>
	selector(baseSessionState);
(useSessionStore as any).getState = () => baseSessionState;
mock.module("../../store/session", () => ({ useSessionStore }));

const useSkillsStore = (selector: (s: unknown) => unknown) =>
	selector({ skills: [] });
mock.module("../../store/skills", () => ({ useSkillsStore }));

const { MessageRow, segmentBlocks } = await import("../MessageList");

function row(content: any[]) {
	return {
		main: {
			agentName: "agent",
			message: { role: "assistant", content, timestamp: 10 } as any,
		},
		toolResults: new Map(),
	};
}

afterEach(() => cleanup());

// ---------------------------------------------------------------------------
// 段构建层：空正文 thinking 块不产生过程段
// ---------------------------------------------------------------------------

test("空正文 thinking 块不产生思考段，有正文的照常成段", () => {
	const segs = segmentBlocks([
		{ type: "thinking", thinking: "", thinkingSignature: "sig-1" },
		{ type: "toolCall", name: "edit", id: "c1", arguments: {} },
		{ type: "thinking", thinking: "先看代码结构" },
	]);
	expect(segs.map((s) => s.kind)).toEqual(["toolCalls", "thinking"]);
	const thinking = segs.find((s) => s.kind === "thinking") as any;
	expect(thinking.texts).toEqual(["先看代码结构"]);
});

test("纯空白正文（换行/空格）同样不成段", () => {
	const segs = segmentBlocks([
		{ type: "thinking", thinking: "\n  \n", thinkingSignature: "sig-2" },
		{ type: "text", text: "正文照常" },
	]);
	expect(segs.map((s) => s.kind)).toEqual(["text"]);
});

// ---------------------------------------------------------------------------
// 渲染层：走流式分支（卡片展开，与非折叠轮一致）
// ---------------------------------------------------------------------------

test("渲染：空正文 thinking 块不出现空白思考卡，正文不受影响", () => {
	render(
		<MessageRow
			row={row([
				{ type: "thinking", thinking: "", thinkingSignature: "sig-1" },
				{ type: "text", text: "正文照常" },
			])}
			sessionId="s1"
			isStreaming
		/>,
	);
	expect(screen.queryByTestId("thinking-panel")).toBeNull();
	expect(document.body.textContent).toContain("正文照常");
});

test("渲染：有正文的 thinking 块照常出现思考卡", () => {
	render(
		<MessageRow
			row={row([{ type: "thinking", thinking: "先看代码结构" }])}
			sessionId="s1"
			isStreaming
		/>,
	);
	expect(screen.getByTestId("thinking-panel")).toBeTruthy();
});
