// 子代理运行期间自动滚动测试。
// 复刻 bug：virtuoso 改造后移除了每帧贴底 rAF 循环，子代理 progress 增长不改变
// listRows.length，强制滚动 effect 不触发。修复方案：autoScrollActive && stickBottom
// 时 200ms interval 定期 scrollToIndex 到末行。
//
// mock react-virtuoso 捕获 scrollToIndex 调用（同 enter-scroll.test.tsx 模式）。
import { test, expect, mock, beforeEach } from "bun:test";
import { render, waitFor } from "@testing-library/react";

const scrollToIndexCalls: any[] = [];
mock.module("react-virtuoso", () => {
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
			{ "data-testid": "message-list" },
			data.map((item: any, i: number) => props.itemContent(i, item)),
		);
	});
	return { Virtuoso };
});

mock.module("../src/api-client", () => ({
	api: {
		get: () => Promise.resolve(null),
		post: () => Promise.resolve({}),
		put: () => Promise.resolve({}),
		del: () => Promise.resolve({}),
	},
}));

import type { SessionMessage } from "@wa-pi/shared";
import { MessageList } from "../src/components/MessageList";
import { useSessionStore } from "../src/store/session";
import { useProjectsStore } from "../src/store/projects";
import { useProvidersStore } from "../src/store/providers";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { useToastStore } from "../src/store/toast";

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

beforeEach(() => {
	scrollToIndexCalls.length = 0;
	useSessionStore.setState({
		messagesBySession: {},
		streamingBySession: {},
		statusBySession: {},
		progressByToolCall: {},
		progressSessionByToolCall: {},
		netStatusBySession: {},
	});
	useProjectsStore.setState({ sessions: [] });
	useProvidersStore.setState({ providers: [] });
	useComposerPrefsStore.setState({ bySession: {} });
	useToastStore.setState({ toasts: [] });
});

test("子代理运行中时定期 scrollToIndex 到末行（interval 贴底）", async () => {
	useSessionStore.setState({
		messagesBySession: {
			s1: [userMsg(1, "帮我查一下"), assistantMsg(2, "好的，委派子代理")],
		},
		statusBySession: { s1: "thinking" },
		progressByToolCall: {
			tc1: {
				Explore: {
					agent: "Explore",
					status: "running",
					output: "正在搜索...",
					tools: [],
					elapsedMs: 1000,
				},
			},
		},
		progressSessionByToolCall: { tc1: "s1" },
	});

	render(<MessageList sessionId="s1" />);

	// 等待初始 effect（进入会话 + 强制贴底）滚动完成
	await waitFor(() => expect(scrollToIndexCalls.length).toBeGreaterThan(0));
	const initialCount = scrollToIndexCalls.length;

	// 等 600ms：interval（200ms）应至少触发 2 次额外的 scrollToIndex
	await new Promise((r) => setTimeout(r, 600));
	expect(scrollToIndexCalls.length).toBeGreaterThan(initialCount);

	// 最后一次调用的 index 应为末行（index=1，共 2 行消息）
	const last = scrollToIndexCalls[scrollToIndexCalls.length - 1];
	expect(last.index).toBe(1);
	expect(last.align).toBe("end");
});

test("子代理完成后 autoScrollActive 变 false → interval 停止", async () => {
	useSessionStore.setState({
		messagesBySession: {
			s1: [userMsg(1, "帮我查一下"), assistantMsg(2, "好的")],
		},
		statusBySession: { s1: "idle" },
		progressByToolCall: {},
		progressSessionByToolCall: {},
	});

	render(<MessageList sessionId="s1" />);

	// 等待初始 effect 滚动完成
	await waitFor(() => expect(scrollToIndexCalls.length).toBeGreaterThan(0));
	const countAfterInit = scrollToIndexCalls.length;

	// 等 500ms 确认无 interval 持续触发（autoScrollActive=false）
	await new Promise((r) => setTimeout(r, 500));
	expect(scrollToIndexCalls.length).toBe(countAfterInit);
});
