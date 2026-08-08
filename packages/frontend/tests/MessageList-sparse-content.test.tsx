import { test, expect, beforeEach } from "bun:test";
import { render, screen } from "@testing-library/react";
import { MessageList } from "../src/components/MessageList";
import { useSessionStore } from "../src/store/session";
import { useProjectsStore } from "../src/store/projects";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { useToastStore } from "../src/store/toast";
import type { SessionMessage } from "@wa-pi/shared";

beforeEach(() => {
	useSessionStore.setState({ messagesBySession: {}, progressByToolCall: {} });
	useProjectsStore.setState({ sessions: [] });
	useComposerPrefsStore.setState({ bySession: {} });
	useToastStore.setState({ toasts: [] });
});

function assistantMsg(
	timestamp: number,
	content: any[],
	agentName: SessionMessage["agentName"] = "product",
): SessionMessage {
	return {
		agentName,
		message: {
			role: "assistant",
			content,
			model: "pi-test",
			stopReason: "end_turn",
			timestamp,
		},
	};
}

// 稀疏数组空洞：text → toolCall → text 流式累积时 content[1] 从未赋值
test("复现：content 含稀疏空洞（text→toolCall→text）渲染 MessageList 不崩溃", () => {
	const content: any[] = [];
	content[0] = { type: "text", text: "第一段" };
	content[2] = { type: "text", text: "第二段" }; // content[1] 是空洞

	useSessionStore.setState({
		messagesBySession: {
			s1: [assistantMsg(1, content)],
		},
	});
	render(<MessageList sessionId="s1" />);
	fireEventExpand();

	// 渲染不崩，两段文本可见
	expect(screen.getByText(/第一段/)).toBeTruthy();
	expect(screen.getByText(/第二段/)).toBeTruthy();
});

// 显式 undefined 元素：历史 JSONL/合并展开带入
test("复现：content 含显式 undefined 元素渲染 MessageList 不崩溃", () => {
	const content = [
		{ type: "text", text: "正常段落" },
		undefined as any,
		{ type: "text", text: "后续段落" },
	];

	useSessionStore.setState({
		messagesBySession: {
			s1: [assistantMsg(1, content)],
		},
	});
	render(<MessageList sessionId="s1" />);
	fireEventExpand();

	expect(screen.getByText(/正常段落/)).toBeTruthy();
	expect(screen.getByText(/后续段落/)).toBeTruthy();
});

// 辅助：已定稿轮默认折叠进摘要行，先展开再断言消息体
function fireEventExpand() {
	const turnSummary = document.querySelector("[data-testid='turn-summary']");
	if (turnSummary) {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		const { fireEvent } = require("@testing-library/react");
		fireEvent.click(turnSummary);
	}
}
