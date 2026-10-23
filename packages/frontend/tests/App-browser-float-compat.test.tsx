import "./mock-composer-db";
import { test, expect, mock, beforeEach } from "bun:test";
import { render, act, waitFor } from "@testing-library/react";

// 浏览器（无 Electron 桥）环境复现：happy-dom 里 window.waPiPreviewWin 天然是 undefined，
// 正是被测场景。float 的承载者是 Electron 独立窗口，无桥时它没有任何承载者 —— 旧实现下
// store.mode 为 float 会让预览彻底消失（App 只渲染 FloatPreview 气泡、非 minimized 时
// 返回 null），而面板不渲染又意味着没有 UI 出路切回内嵌。

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

test("浏览器（无 Electron 桥）里 store 处于 float 时，预览仍按分屏渲染（不吞掉 html 预览）", async () => {
	useProjectsStore.setState({
		projects: [{ id: "p1", name: "P", cwd: "/p", createdAt: 0 }],
		sessions: [session],
		currentProjectId: "p1",
		currentSessionId: "s1",
	});
	const { container } = render(<App />);
	await waitFor(() =>
		expect(container.querySelector('[data-testid="session-view"]')).toBeTruthy(),
	);

	// 用户复现路径：打开 html 预览（浏览器里 localStorage 可能留着 float 偏好，
	// 0.3.20 的 float 是主窗口内 DOM 浮层，升级后同 key 变成独立窗口语义）
	act(() => {
		useBrowserStore.getState().openBrowser("/tmp/index.html", "s1");
	});
	act(() => {
		useBrowserStore.setState({ mode: "float" });
	});

	// 预览面板必须可见（无桥时降级为分屏承载）
	await waitFor(() =>
		expect(container.querySelector('[data-testid="browser-panel"]')).toBeTruthy(),
	);
	expect(
		container.querySelector('[data-testid="browser-split-resizer"]'),
	).toBeTruthy();
});
