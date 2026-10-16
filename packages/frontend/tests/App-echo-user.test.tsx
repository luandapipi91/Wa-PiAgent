// App 层集成测试：session:echo_user 事件经 App 事件分发后不重复追加 user 消息。
// 覆盖「发送消息 + notify 穿插 → user 显示 2 条」的端到端回归。
import "./mock-composer-db";
import { test, expect, beforeEach, mock } from "bun:test";
import { render, waitFor } from "@testing-library/react";
import type { AgentConfig } from "@wa-pi/shared";

// mock fetch：SessionView 挂载时读 /api/sessions/:id/messages
const fetchMock = mock((input: any) => {
	const url = String(input);
	if (url.includes("/messages")) {
		return Promise.resolve({
			ok: true,
			json: () => Promise.resolve({ messages: [], isActive: false }),
		} as any);
	}
	return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as any);
}) as any;

mock.module("../src/api-client", () => ({
	api: {
		get: (path: string) =>
			path.includes("/messages")
				? Promise.resolve({ messages: [], isActive: false, thinkingSince: null })
				: Promise.resolve(null),
		post: () => Promise.resolve({}),
		put: () => Promise.resolve({}),
		del: () => Promise.resolve({}),
	},
	ApiError: class extends Error {
		status: number;
		constructor(m: string, s: number) {
			super(m);
			this.status = s;
			this.name = "ApiError";
		}
	},
}));

// 隔离 SSE 总线：捕获 onMessage 注册的 handler，提供 emit 注入事件
const eventHandlers = new Set<(e: any) => void>();
mock.module("../src/events", () => ({
	onMessage: (cb: any) => {
		eventHandlers.add(cb);
		return () => eventHandlers.delete(cb);
	},
	onEventType: () => () => {},
	connectEvents: () => {},
	disconnectEvents: () => {
		eventHandlers.clear();
	},
	onReconnect: () => () => {},
	emitEventForTesting: (e: any) => {
		eventHandlers.forEach((h) => h(e));
	},
	onConnectionChange: () => () => {},
	getConnectionState: () => "connected",
}));

import { App } from "../src/App";
import { useProjectsStore } from "../src/store/projects";
import { useAgentsStore } from "../src/store/agents";
import { useSessionStore } from "../src/store/session";

const agent = (displayName: string): AgentConfig => ({
	displayName,
	avatar: "",
	avatarColor: "",
	description: "",
	model: "m",
	thinking: "medium",
	tools: [],
	skills: [],
	mcpServers: [],
	partners: { askTo: [] },
});

const session = {
	id: "s1",
	projectId: "p1",
	primaryAgent: "dev",
	title: "测试",
	createdAt: 0,
	lastActivity: 0,
	piSessionFile: "",
};

const emit = (e: any) => eventHandlers.forEach((h) => h(e));

function sdkEvent(event: any, sid = "s1"): any {
	return {
		type: "sdk:event",
		projectId: "p1",
		sessionId: sid,
		agentName: "dev",
		event,
	};
}

beforeEach(() => {
	globalThis.fetch = fetchMock;
	useProjectsStore.setState({
		projects: [{ id: "p1", name: "P", cwd: "/p", createdAt: 0 }],
		sessions: [session],
		currentProjectId: "p1",
		currentSessionId: "s1",
	});
	useAgentsStore.setState({
		list: [],
		configs: { dev: agent("dev") },
	});
	useSessionStore.setState({
		messagesBySession: {},
		streamingBySession: {},
		statusBySession: {},
		optimisticEchoBySession: {},
		thinkingSinceBySession: {},
	});
});

test("echo_user 在 message_start 清标志后到达：user 消息不重复", async () => {
	render(<App />);
	// 1. 用户发送（乐观置入 + 标志=true）
	useSessionStore.getState().optimisticSend("s1", "你好", "dev");
	// 2. SDK message_start(user) 先到：替换占位 + 清标志
	emit(
		sdkEvent({
			type: "message_start",
			message: { role: "user", content: "你好", timestamp: 999 },
		}),
	);
	await waitFor(() =>
		expect(useSessionStore.getState().optimisticEchoBySession["s1"]).toBe(false),
	);
	// 3. kernel echo_user 后到（notify 穿插致时序错位）
	emit({
		type: "session:echo_user",
		sessionId: "s1",
		text: "你好",
		agentName: "dev",
	});
	await waitFor(() => {
		const userMsgs = useSessionStore
			.getState()
			.messagesBySession["s1"].filter(
				(m) => (m.message as any).role === "user",
			);
		expect(userMsgs).toHaveLength(1);
	});
});

test("echo_user 正常时序（先于 message_start）：标志为 true 跳过，user 不重复", async () => {
	render(<App />);
	useSessionStore.getState().optimisticSend("s1", "你好", "dev");
	emit({
		type: "session:echo_user",
		sessionId: "s1",
		text: "你好",
		agentName: "dev",
	});
	emit(
		sdkEvent({
			type: "message_start",
			message: { role: "user", content: "你好", timestamp: 999 },
		}),
	);
	await waitFor(() => {
		const userMsgs = useSessionStore
			.getState()
			.messagesBySession["s1"].filter(
				(m) => (m.message as any).role === "user",
			);
		expect(userMsgs).toHaveLength(1);
	});
});
