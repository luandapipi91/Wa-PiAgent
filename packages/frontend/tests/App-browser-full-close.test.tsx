import "./mock-composer-db";
import { test, expect, mock, beforeEach } from "bun:test";
import { render, act, waitFor } from "@testing-library/react";

// SessionView 挂载会拉 /api/sessions/:id/messages：返回空历史，其余路径返回 null
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

mock.module("../src/events", () => ({
	connectEvents: () => {},
	onMessage: () => () => {},
	onReconnect: () => () => {},
	onEventType: () => () => {},
	disconnectEvents: () => {},
	emitEventForTesting: () => {},
}));

import { App } from "../src/App";
import { useProjectsStore } from "../src/store/projects";
import { useAgentsStore } from "../src/store/agents";
import { useSessionStore } from "../src/store/session";
import { useBrowserStore } from "../src/store/browser";

const session = {
	id: "s1",
	projectId: "p1",
	primaryAgent: "dev",
	title: "会话一",
	createdAt: 0,
	lastActivity: 0,
	piSessionFile: "/tmp/s1.jsonl",
};

beforeEach(() => {
	useProjectsStore.setState({
		projects: [],
		sessions: [],
		currentProjectId: null,
		currentSessionId: null,
	});
	useAgentsStore.setState({
		list: [],
		configs: {
			dev: {
				displayName: "dev",
				avatar: "",
				avatarColor: "",
				description: "",
				model: "m",
				thinking: "medium",
				tools: [],
				skills: [],
				mcpServers: [],
				partners: { askTo: [] },
			},
		},
	});
	useSessionStore.setState({
		messagesBySession: {},
		streamingBySession: {},
		statusBySession: {},
		optimisticEchoBySession: {},
		thinkingSinceBySession: {},
	});
	useBrowserStore.setState({
		open: false,
		mode: "split",
		path: null,
		sessionId: null,
		minimized: false,
		bySession: {},
	});
});

test("全屏预览关闭后，会话视图不重挂载（文件树展开等内部状态保留）", async () => {
	useProjectsStore.setState({
		projects: [{ id: "p1", name: "P", cwd: "/p", createdAt: 0 }],
		sessions: [session],
		currentProjectId: "p1",
		currentSessionId: "s1",
	});
	const { container } = render(<App />);

	// 等派生 effect 把 view 切到 session，SessionView 挂载
	const sv1 = await waitFor(() => {
		const el = container.querySelector('[data-testid="session-view"]');
		expect(el).toBeTruthy();
		return el!;
	});

	// 用户复现路径：打开预览 → 切全屏 → 全屏下点关闭
	act(() => {
		useBrowserStore.getState().openBrowser("/tmp/index.html", "s1");
	});
	act(() => {
		useBrowserStore.getState().setMode("full");
	});
	// 全屏时聊天侧仅视觉隐藏，仍挂在文档中（子树不重建）
	expect(container.contains(sv1)).toBe(true);

	act(() => {
		useBrowserStore.getState().closeBrowser();
	});
	// 关闭后回到会话窗口：必须还是同一个 DOM 节点——节点重建 = 内部状态（文件树展开等）全丢
	const sv2 = container.querySelector('[data-testid="session-view"]');
	expect(sv2).toBe(sv1);
});
