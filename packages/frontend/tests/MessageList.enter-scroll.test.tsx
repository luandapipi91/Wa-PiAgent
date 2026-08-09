// 进入会话滚动定位测试（task-6 审查 Important-1 回归守护）。
// happy-dom 无真实滚动几何，mock react-virtuoso 捕获 scrollToIndex 调用，
// 断言「异步历史消息到达后」滚动定位发生在最后一行（最新回复）——
// 复刻 SessionView 异步 api.get(.../messages) 加载历史、首访空缓存的场景。
import { test, expect, mock, beforeEach } from "bun:test";
import { render, waitFor } from "@testing-library/react";

// scrollToIndex 调用记录（每次 push { index, align, behavior }）
const scrollToIndexCalls: any[] = [];
mock.module("react-virtuoso", () => {
	// require 在 bun:test 文件内可用（同 MessageList-sparse-content.test.tsx）
	const { forwardRef, useImperativeHandle, createElement } = require("react");
	const Virtuoso = forwardRef(function MockVirtuoso(props: any, ref: any) {
		useImperativeHandle(
			ref,
			() => ({
				scrollToIndex: (opts: any) => scrollToIndexCalls.push(opts),
			}),
			[],
		);
		const data = props.data ?? [];
		return createElement(
			"div",
			{ "data-testid": "message-list", "data-virtuoso-scroller": "true" },
			data.map((item: any, i: number) => props.itemContent(i, item)),
		);
	});
	return { Virtuoso };
});

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

// 长历史：49 条消息，最后一行 index=48（0-indexed）
function longHistory(): SessionMessage[] {
	const arr: SessionMessage[] = [userMsg(1, "首问")];
	for (let i = 0; i < 24; i++) {
		arr.push(assistantMsg(100 + i * 2, `回答${i}`));
		arr.push(userMsg(101 + i * 2, `追问${i}`));
	}
	return arr;
}

beforeEach(() => {
	scrollToIndexCalls.length = 0;
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

test("首访空缓存会话 → 异步历史到达后定位到最后一行（最新回复）", async () => {
	// 首访：store 无缓存，挂载时 messages=[]（模拟 SessionView 异步加载历史前的状态）
	render(<MessageList sessionId="s1" />);
	// 挂载时 listRows 为空，进入会话 effect 早退（不应 scrollToIndex）
	expect(scrollToIndexCalls.length).toBe(0);

	// 模拟 SessionView 异步 setMessages（api.get(.../messages) 返回后填入历史）
	useSessionStore.getState().setMessages("s1", longHistory());

	// 修复后：listRows.length 由 0 变非空触发 effect 重跑，滚动到最后一行（index 48）
	await waitFor(() => {
		const last = scrollToIndexCalls[scrollToIndexCalls.length - 1];
		expect(last?.index).toBe(48);
	});
});

test("复访有缓存会话 → 挂载即定位到最新回复", async () => {
	// 复访：store 已有该会话历史缓存（模拟 store 命中）
	useSessionStore.setState({
		messagesBySession: { s1: longHistory() },
	});
	render(<MessageList sessionId="s1" />);
	// 挂载即有 listRows（length 49），进入会话 effect 立即滚到末行（index 48）
	await waitFor(() => {
		const last = scrollToIndexCalls[scrollToIndexCalls.length - 1];
		expect(last?.index).toBe(48);
	});
});

test("切换到空缓存会话 → 异步历史到达后定位到最新回复", async () => {
	// 先在 s1 已初始化（有缓存）
	useSessionStore.setState({
		messagesBySession: { s1: [userMsg(1, "q"), assistantMsg(2, "a")] },
	});
	const { rerender } = render(<MessageList sessionId="s1" />);
	await waitFor(() => expect(scrollToIndexCalls.length).toBeGreaterThan(0));

	// 切换到 s2（空缓存）
	rerender(<MessageList sessionId="s2" />);
	scrollToIndexCalls.length = 0; // 忽略 s1 的初始化滚动

	// s2 异步历史到达
	useSessionStore.getState().setMessages("s2", longHistory());
	await waitFor(() => {
		const last = scrollToIndexCalls[scrollToIndexCalls.length - 1];
		expect(last?.index).toBe(48);
	});
});
