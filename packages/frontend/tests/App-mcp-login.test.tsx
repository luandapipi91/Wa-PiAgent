// App 层集成测试：WS 的 mcp:login 事件经 App.tsx 的事件分发落进 useMcpStore.loginStates。
//
// 为什么必须有这一层：登录是「POST 只表示已受理、授权 URL 与结果全经 SSE 回流」的长任务，
// App.tsx 里的 `case "mcp:login": setLoginEvent(...)` 是前端唯一的入口——写错（漏调、事件名
// 拼错）时 store 单测与卡片单测都仍然全绿，而线上功能完全不可用。
import "./mock-composer-db";
import { test, expect, mock, beforeEach } from "bun:test";
import { render, waitFor } from "@testing-library/react";

mock.module("../src/api-client", () => ({
	api: {
		// get 返回 null（falsy）：App 挂载时各 store.loadAll/load 的 if(data) 分支不触发，
		// 避免异步覆盖本文件在 beforeEach 预设的 store 状态
		get: () => Promise.resolve(null),
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

// 隔离 SSE 事件总线：捕获 onMessage 注册的 handler，供 emitEvent 注入 WS 事件
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
}));

import { App } from "../src/App";
import { useProjectsStore } from "../src/store/projects";
import { useMcpStore } from "../src/store/mcp";

const emitEvent = (e: any) => {
	eventHandlers.forEach((h) => h(e));
};

const AUTH_URL = "http://127.0.0.1:59998/authorize?client_id=x";

beforeEach(() => {
	eventHandlers.clear();
	useProjectsStore.setState({
		projects: [{ id: "p1", name: "P", cwd: "/p", createdAt: 0 }],
		sessions: [],
		currentProjectId: "p1",
		currentSessionId: null,
	});
	// 全局作用域（事件不带 projectId）→ store 的作用域过滤按 null 比对
	useMcpStore.setState({ selectedProjectId: null, loginStates: {}, servers: [] });
});

test("mcp:login 的 running / authorizationUrl 经 App 分发后落进 store（卡片拿到授权 URL 与进度）", async () => {
	render(<App />);

	emitEvent({
		type: "mcp:login",
		serverName: "srv",
		phase: "running",
		line: 'Sign in to MCP server "srv" in your browser:',
	});
	emitEvent({
		type: "mcp:login",
		serverName: "srv",
		phase: "authorizationUrl",
		url: AUTH_URL,
	});

	await waitFor(() => {
		const st = useMcpStore.getState().loginStates["srv"];
		expect(st?.url).toBe(AUTH_URL);
		expect(st?.progress).toContain("Sign in to MCP server");
		expect(st?.pending).toBe(true);
	});
});

test("mcp:login 的 error 经 App 分发后落进 store（卡片不再停在「等待授权」）", async () => {
	render(<App />);

	emitEvent({
		type: "mcp:login",
		serverName: "srv",
		phase: "error",
		error: "cancelled or not completed within 300 seconds",
	});

	await waitFor(() => {
		const st = useMcpStore.getState().loginStates["srv"];
		expect(st?.pending).toBe(false);
		expect(st?.error).toBe("cancelled or not completed within 300 seconds");
	});
});

test("mcp:login 的 ok 经 App 分发后清掉流程状态（回到「已登录」形态）", async () => {
	useMcpStore.setState({
		selectedProjectId: null,
		loginStates: { srv: { pending: true, url: AUTH_URL } },
	});
	render(<App />);

	emitEvent({ type: "mcp:login", serverName: "srv", phase: "ok" });

	await waitFor(() => {
		expect(useMcpStore.getState().loginStates["srv"]).toBeUndefined();
	});
});
