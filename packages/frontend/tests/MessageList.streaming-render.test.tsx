import { test, expect, beforeEach, mock } from "bun:test";
import { render, act } from "@testing-library/react";
import type { SessionMessage } from "@wa-pi/shared";

// 流式卡顿回归测试：mock react-markdown 并统计渲染次数。
// 修复前：streaming 每帧变化 → MessageList 全量重渲染 → 所有历史行的 Markdown 重新解析。
// 修复后：preprocess useMemo + MessageRow memo → 只有合并的流式末行重渲染。
let mdRenderCount = 0;
mock.module("react-markdown", () => ({
	default: (props: any) => {
		mdRenderCount++;
		return <div data-testid="md-mock">{props.children}</div>;
	},
}));

import { MessageList } from "../src/components/MessageList";
import { useSessionStore } from "../src/store/session";
import { useProjectsStore } from "../src/store/projects";

function userMsg(timestamp: number, text: string): SessionMessage {
	return { agentName: undefined, message: { role: "user", content: text, timestamp } } as SessionMessage;
}

function assistantMsg(timestamp: number, text: string, agentName: SessionMessage["agentName"] = "product"): SessionMessage {
	return {
		agentName,
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			model: "pi-test",
			stopReason: "end_turn",
			timestamp,
		},
	} as SessionMessage;
}

function streamingMsg(text: string): SessionMessage {
	return {
		agentName: "product",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			model: "pi-test",
			timestamp: 99,
		},
	} as SessionMessage;
}

beforeEach(() => {
	mdRenderCount = 0;
	useSessionStore.setState({ messagesBySession: {}, streamingBySession: {} });
	useProjectsStore.setState({ sessions: [] });
});

test("流式更新时历史消息行不重渲染（Markdown 不重解析）", () => {
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
	render(<MessageList sessionId="s1" />);
	// 初始：两条 assistant 各渲染一次 Markdown
	const initial = mdRenderCount;
	expect(initial).toBe(2);

	// 流式帧 1：同 agent 的 assistant 增量并入最后一条已完稿 assistant 行（合并行）。
	// 合并行 content = 回答二 + 流式文本 → 2 个 text block → 2 次 md 渲染；历史行 0 次。
	act(() => {
		useSessionStore.setState({
			streamingBySession: { s1: streamingMsg("流式中") },
		});
	});
	expect(mdRenderCount - initial).toBe(2);

	// 流式帧 2：内容增长，仍然只有合并行重渲染（历史行 memo 命中）。
	act(() => {
		useSessionStore.setState({
			streamingBySession: { s1: streamingMsg("流式中……更长了") },
		});
	});
	expect(mdRenderCount - initial).toBe(4);
});
