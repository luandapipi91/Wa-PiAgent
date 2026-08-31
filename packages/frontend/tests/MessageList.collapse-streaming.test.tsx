import { test, expect, beforeEach } from "bun:test";
import { render, screen } from "@testing-library/react";
import { MessageList } from "../src/components/MessageList";
import { VirtuosoMockContext } from "react-virtuoso";
import { useSessionStore } from "../src/store/session";
import { useProjectsStore } from "../src/store/projects";
import { useSettingsStore } from "../src/store/settings";
import { useUiPrefsStore } from "../src/store/ui-prefs";
import { COLLAPSE_PROCESS_DEFAULT } from "../src/store/ui-prefs";

function assistantMsg(timestamp: number, content: any[]): any {
	return {
		agentName: "product",
		message: {
			role: "assistant",
			content,
			model: "pi-test",
			stopReason: "end_turn",
			timestamp,
		},
	};
}

beforeEach(() => {
	useSessionStore.setState({
		messagesBySession: {},
		streamingBySession: {},
		statusBySession: {},
		progressByToolCall: {},
		progressSessionByToolCall: {},
		netStatusBySession: {},
	});
	useProjectsStore.setState({ sessions: [] });
	useUiPrefsStore.setState({ collapseProcessByDefault: COLLAPSE_PROCESS_DEFAULT });
});

// 对话进行中：streamingBySession 有流式 thinking（isStreaming 路径）。
// 开关开启（collapseProcessByDefault=true）时，流式 thinking 也应默认折叠。
test("对话进行中：流式 thinking 块在开关开启时默认折叠（body 不渲染）", () => {
	useSessionStore.setState({
		messagesBySession: { s1: [] },
		statusBySession: { s1: "thinking" },
		streamingBySession: {
			s1: assistantMsg(10, [{ type: "thinking", thinking: "让我想想" }]),
		},
	});
	render(
		<VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 60 }}>
			<MessageList sessionId="s1" />
		</VirtuosoMockContext.Provider>,
	);
	// header 可见，body 默认不渲染（折叠）
	expect(screen.getByTestId("thinking-panel-header")).toBeTruthy();
	expect(screen.queryByTestId("thinking-panel-body")).toBeNull();
});

// 开关关闭（恢复旧行为）：流式 thinking 默认展开
test("对话进行中：流式 thinking 块在开关关闭时默认展开（回归防护）", () => {
	useUiPrefsStore.setState({ collapseProcessByDefault: false });
	useSessionStore.setState({
		messagesBySession: { s1: [] },
		statusBySession: { s1: "thinking" },
		streamingBySession: {
			s1: assistantMsg(10, [{ type: "thinking", thinking: "让我想想" }]),
		},
	});
	render(
		<VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 60 }}>
			<MessageList sessionId="s1" />
		</VirtuosoMockContext.Provider>,
	);
	expect(screen.getByTestId("thinking-panel-body").textContent).toContain(
		"让我想想",
	);
});
