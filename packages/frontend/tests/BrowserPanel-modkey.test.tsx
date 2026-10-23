// BrowserPanel × waPiModKey：预览「选择元素」快捷键单点收敛后的前端接线。
//
// 背景（2026-10-10）：Cmd/Ctrl 单按切换原先在预览 iframe 内注入脚本 + 主应用
// window 双通道 DOM 监听并存，收敛为 Electron 主进程 before-input-event 单点监听
// → IPC（wa-pi:modkey-tap）→ 前端订阅回调切换 → postMessage 下发 iframe。
// 本文件锁定前端行为：waPiModKey 回调触发时切换开关并下发 iframe；
// 非 Electron 环境（无 waPiModKey 桥）不挂订阅、快捷键静默降级（工具栏按钮仍可切）。
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

const INSPECT_KEY = "hiagent.preview.inspect";

const session = {
	id: "s1",
	projectId: "p1",
	primaryAgent: "dev",
	title: "会话一",
	createdAt: 0,
	lastActivity: 0,
	piSessionFile: "/tmp/s1.jsonl",
};

let modKeyCbs: Array<() => void>;

beforeEach(() => {
	modKeyCbs = [];
	// 模拟 preload 注入的快捷键桥（desktop 下存在；浏览器 dev 下 undefined）
	(window as any).waPiModKey = {
		onTapModKey: (cb: () => void) => {
			modKeyCbs.push(cb);
			return () => {};
		},
	};
	localStorage.setItem(INSPECT_KEY, "off"); // 初始关闭，tap 一次应变 on
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

/** 打开预览面板并等 BrowserPanel 挂载，返回容器 */
async function openPreview() {
	useProjectsStore.setState({
		projects: [{ id: "p1", name: "P", cwd: "/p", createdAt: 0 }],
		sessions: [session],
		currentProjectId: "p1",
		currentSessionId: "s1",
	});
	useBrowserStore.setState({
		open: true,
		mode: "split",
		path: "/tmp/preview-fixture.html",
		sessionId: "s1",
	});
	const { container } = render(<App />);
	await waitFor(() => {
		if (!container.querySelector('[data-testid="browser-panel"]'))
			throw new Error("BrowserPanel 未挂载");
	});
	return container;
}

test("waPiModKey 回调触发 → 切换拾取开关并 postMessage 下发 iframe", async () => {
	const container = await openPreview();
	// 订阅已建立（loadedPath 非空 → effect 挂载）
	expect(modKeyCbs.length).toBe(1);

	// 捕获 iframe 的 postMessage（happy-dom contentWindow）
	const iframe = container.querySelector("iframe")!;
	const postCalls: any[] = [];
	const cw = iframe.contentWindow as any;
	const originalPost = cw?.postMessage?.bind(cw);
	if (cw)
		cw.postMessage = (...args: any[]) => {
			postCalls.push(args);
		};

	act(() => {
		modKeyCbs[0]();
	});

	// localStorage 持久化翻转 off → on
	expect(localStorage.getItem(INSPECT_KEY)).toBe("on");
	// 下发 iframe：hiagent:inspect:set enabled=true
	const setMsg = postCalls.find(
		([d]) => d && d.type === "hiagent:inspect:set" && d.enabled === true,
	);
	expect(setMsg).toBeTruthy();
	// 再 tap 一次：翻回 off
	act(() => {
		modKeyCbs[0]();
	});
	expect(localStorage.getItem(INSPECT_KEY)).toBe("off");
	const offMsg = postCalls.find(
		([d]) => d && d.type === "hiagent:inspect:set" && d.enabled === false,
	);
	expect(offMsg).toBeTruthy();
	if (originalPost) cw.postMessage = originalPost;
});

test("非 Electron 环境（无 waPiModKey 桥）：不订阅、面板正常挂载（快捷键静默降级）", async () => {
	delete (window as any).waPiModKey;
	const container = await openPreview();
	expect(container.querySelector('[data-testid="browser-panel"]')).toBeTruthy();
	expect(modKeyCbs.length).toBe(0);
});
