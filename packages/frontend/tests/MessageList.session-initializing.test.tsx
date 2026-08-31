// 新建会话发送后等服务器回调期间，MessageList 显示「会话新建中」加载页（不白屏）。
// 时间戳+窗口方案：NewSessionPane.handleSend 记录发送时刻戳；窗口内无消息/流式时显示，
// 回调到达后消息出现、条件自然失效；无回调时窗口到期自动隐藏（兜底）。
import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen } from "@testing-library/react";

mock.module("react-virtuoso", () => {
	const { forwardRef, useImperativeHandle, createElement } = require("react");
	const Virtuoso = forwardRef(function MockVirtuoso(props: any, ref: any) {
		useImperativeHandle(ref, () => ({ scrollToIndex: () => {} }), []);
		const data = props.data ?? [];
		return createElement(
			"div",
			{
				"data-testid": "message-list",
				ref: (el: any) => props.scrollerRef?.(el),
			},
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

import {
	MessageList,
	INITIALIZING_WINDOW_MS,
} from "../src/components/MessageList";
import { useSessionStore } from "../src/store/session";
import { useProjectsStore } from "../src/store/projects";
import { useProvidersStore } from "../src/store/providers";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { useToastStore } from "../src/store/toast";

beforeEach(() => {
	useSessionStore.setState({
		messagesBySession: {},
		streamingBySession: {},
		statusBySession: {},
		historyLoadingBySession: {},
		pendingPromptAtBySession: {},
		progressByToolCall: {},
		progressSessionByToolCall: {},
		netStatusBySession: {},
	} as any);
	useProjectsStore.setState({ sessions: [] } as any);
	useProvidersStore.setState({ providers: [] } as any);
	useComposerPrefsStore.setState({ bySession: {} } as any);
	useToastStore.setState({ toasts: [] } as any);
});

test("发送后窗口内显示「会话新建中」加载页（不白屏）", () => {
	useSessionStore.setState({
		pendingPromptAtBySession: { s1: Date.now() },
		historyLoadingBySession: { s1: false },
		messagesBySession: { s1: [] },
		streamingBySession: {},
		statusBySession: { s1: "idle" },
	} as any);
	render(<MessageList sessionId="s1" />);
	expect(screen.getByTestId("session-initializing-s1")).toBeTruthy();
});

test("收到服务器回调后（messages 非空）不再显示加载页", () => {
	useSessionStore.setState({
		pendingPromptAtBySession: { s1: Date.now() },
		historyLoadingBySession: { s1: false },
		messagesBySession: {
			s1: [
				{
					message: {
						role: "user",
						content: "hi",
						timestamp: Date.now(),
					},
					agentName: undefined,
				},
			],
		},
		streamingBySession: {},
		statusBySession: { s1: "thinking" },
	} as any);
	render(<MessageList sessionId="s1" />);
	expect(screen.queryByTestId("session-initializing-s1")).toBeNull();
});

test("无回调超过窗口时长后自动隐藏（兜底）", () => {
	useSessionStore.setState({
		pendingPromptAtBySession: {
			s1: Date.now() - INITIALIZING_WINDOW_MS - 5_000,
		},
		historyLoadingBySession: { s1: false },
		messagesBySession: { s1: [] },
		streamingBySession: {},
		statusBySession: { s1: "idle" },
	} as any);
	render(<MessageList sessionId="s1" />);
	expect(screen.queryByTestId("session-initializing-s1")).toBeNull();
});

test("扩展命令被拦截：收到合成 agent_end（无消息）后加载页退出，不白屏", () => {
	// 扩展命令（source=extension）被 pi 拦截执行：无 echo_user / agent_start /
	// message_start，唯一信号是 kernel 50ms 后合成的空 agent_end。此时 messages 仍空、
	// streaming 仍空——若只靠 messages 非空退出，加载页会硬撑到 20s 窗口到期（白屏）。
	useSessionStore.setState({
		pendingPromptAtBySession: { s1: Date.now() },
		historyLoadingBySession: { s1: false },
		messagesBySession: { s1: [] },
		streamingBySession: {},
		statusBySession: { s1: "idle" },
	} as any);
	// 模拟 handleSDKEvent 收到合成 agent_end：清 pendingPromptAt
	useSessionStore.getState().handleSDKEvent("s1", {
		event: { type: "agent_end", sessionId: "s1" } as any,
		agentName: "dev",
	} as any);
	render(<MessageList sessionId="s1" />);
	expect(screen.queryByTestId("session-initializing-s1")).toBeNull();
});

test("pending 窗口内与历史加载互斥：只显示「会话新建中」，不叠加「加载会话」", () => {
	useSessionStore.setState({
		pendingPromptAtBySession: { s1: Date.now() },
		historyLoadingBySession: { s1: true },
		messagesBySession: { s1: [] },
		streamingBySession: {},
		statusBySession: { s1: "idle" },
	} as any);
	render(<MessageList sessionId="s1" />);
	expect(screen.getByTestId("session-initializing-s1")).toBeTruthy();
	expect(screen.queryByTestId("history-loading-s1")).toBeNull();
});

test("pending 已退出后历史加载正常显示（互斥不误伤）", () => {
	useSessionStore.setState({
		pendingPromptAtBySession: { s1: 0 },
		historyLoadingBySession: { s1: true },
		messagesBySession: { s1: [] },
		streamingBySession: {},
		statusBySession: { s1: "idle" },
	} as any);
	render(<MessageList sessionId="s1" />);
	expect(screen.queryByTestId("session-initializing-s1")).toBeNull();
	expect(screen.getByTestId("history-loading-s1")).toBeTruthy();
});

test("pending 窗口内有 promptError 时显示「发送失败」而非加载页", () => {
	useSessionStore.setState({
		pendingPromptAtBySession: { s1: Date.now() },
		promptErrorBySession: { s1: "agent 启动失败: No API key" },
		historyLoadingBySession: { s1: false },
		messagesBySession: { s1: [] },
		streamingBySession: {},
		statusBySession: { s1: "idle" },
	} as any);
	render(<MessageList sessionId="s1" />);
	expect(screen.queryByTestId("session-initializing-s1")).toBeNull();
	expect(screen.getByTestId("prompt-error-s1")).toBeTruthy();
	expect(screen.getByText(/No API key/)).toBeTruthy();
});

test("promptError 在窗口外仍显示（api.post 30s 超时 > 窗口 20s）", () => {
	useSessionStore.setState({
		pendingPromptAtBySession: {
			s1: Date.now() - INITIALIZING_WINDOW_MS - 5_000,
		},
		promptErrorBySession: { s1: "timeout" },
		historyLoadingBySession: { s1: false },
		messagesBySession: { s1: [] },
		streamingBySession: {},
		statusBySession: { s1: "idle" },
	} as any);
	render(<MessageList sessionId="s1" />);
	expect(screen.getByTestId("prompt-error-s1")).toBeTruthy();
});

test("服务器事件到达后 promptError 被清除（echoUser 路径）", () => {
	useSessionStore.setState({
		pendingPromptAtBySession: { s1: Date.now() },
		promptErrorBySession: { s1: "timeout" },
		historyLoadingBySession: { s1: false },
		messagesBySession: { s1: [] },
		streamingBySession: {},
		statusBySession: { s1: "idle" },
	} as any);
	useSessionStore.getState().echoUser("s1", "你好", "dev");
	expect(
		useSessionStore.getState().promptErrorBySession["s1"] ?? "",
	).toBe("");
	render(<MessageList sessionId="s1" />);
	expect(screen.queryByTestId("prompt-error-s1")).toBeNull();
});
