// 虚拟化 + 滚动行为测试（流式卡顿修复 3.5/3.6）。
// happy-dom 无布局，必须用 VirtuosoMockContext 提供测量值，Virtuoso 才渲染行。
import { test, expect, beforeEach } from "bun:test";
import { render, screen } from "@testing-library/react";
import { VirtuosoMockContext } from "react-virtuoso";
import type { SessionMessage } from "@wa-pi/shared";
import { MessageList } from "../src/components/MessageList";
import { useSessionStore } from "../src/store/session";
import { useProjectsStore } from "../src/store/projects";

function userMsg(ts: number, text: string): SessionMessage {
	return {
		agentName: undefined,
		message: { role: "user", content: text, timestamp: ts },
	} as SessionMessage;
}
function assistantMsg(ts: number, text: string): SessionMessage {
	return {
		agentName: "dev",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			model: "m",
			stopReason: "end_turn",
			timestamp: ts,
		},
	} as SessionMessage;
}

function renderList(sessionId = "s1") {
	return render(
		<VirtuosoMockContext.Provider value={{ viewportHeight: 600, itemHeight: 60 }}>
			<MessageList sessionId={sessionId} />
		</VirtuosoMockContext.Provider>,
	);
}

beforeEach(() => {
	useSessionStore.setState({
		messagesBySession: {},
		streamingBySession: {},
		statusBySession: {},
		progressByToolCall: {},
		progressSessionByToolCall: {},
		historyLoadingBySession: {},
	});
	useProjectsStore.setState({ sessions: [] });
});

test("长会话所有消息行在 mock 视口下渲染（itemContent 分发正确）", () => {
	useSessionStore.setState({
		messagesBySession: {
			s1: [
				userMsg(1, "问题一"),
				assistantMsg(2, "回答一"),
				userMsg(3, "问题二"),
				assistantMsg(4, "回答二"),
			],
		},
	});
	renderList();
	expect(screen.getByText("问题一")).toBeTruthy();
	expect(screen.getByText("回答二")).toBeTruthy();
});

test("流式占位行（未合并场景）渲染在列表末尾", () => {
	useSessionStore.setState({
		messagesBySession: { s1: [userMsg(1, "问题一"), assistantMsg(2, "回答一")] },
		streamingBySession: {
			s1: {
				agentName: "product", // 与末行 agentName 不同 → 不合并，独立 StreamingRow
				message: {
					role: "assistant",
					content: [{ type: "text", text: "流式中" }],
					model: "m",
					timestamp: 99,
				},
			} as any,
		},
	});
	renderList();
	expect(screen.getByTestId("msg-s1-99")).toBeTruthy();
});

test("虚拟化容器：不再存在无限 rAF 滚动循环（data-testid=message-list 的自定义 scroller 被 virtuoso scroller 取代）", () => {
	useSessionStore.setState({
		messagesBySession: { s1: [userMsg(1, "q"), assistantMsg(2, "a")] },
	});
	const { container } = renderList();
	// Virtuoso 的 scroller 元素带 data-virtuoso-scroller="true" 标记（data-testid
	// 被 MessageList 传的 message-list 覆盖，故用此属性确认是 Virtuoso 接管了滚动）。
	expect(
		container.querySelector('[data-virtuoso-scroller="true"]'),
	).toBeTruthy();
});
