// App 层集成测试：pi 斜杠命令（wa-pi:pi-command 事件）发送 prompt 时的 thinking 取值。
// 该路径与 Composer 不同（App 内联 handler），曾是「零测试覆盖」的接线点：
// 必须走 resolveThinking（模型记录 → 会话值 → default），不能只看会话值。
import "./mock-composer-db";
import { test, expect, beforeEach, mock } from "bun:test";
import { render, waitFor, act } from "@testing-library/react";

const postCalls: Array<{ url: string; body: any }> = [];
mock.module("../src/api-client", () => ({
	api: {
		get: (path: string) =>
			path.includes("/messages")
				? Promise.resolve({ messages: [], isActive: false, thinkingSince: null })
				: Promise.resolve(null),
		post: (url: string, body?: any) => {
			postCalls.push({ url, body });
			return Promise.resolve({});
		},
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
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import type { AgentConfig } from "@wa-pi/shared";

const agent = (displayName: string): AgentConfig => ({
	displayName,
	avatar: "",
	avatarColor: "",
	description: "",
	model: "m",
	thinking: "default",
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

beforeEach(() => {
	postCalls.length = 0;
	useProjectsStore.setState({
		projects: [{ id: "p1", name: "P", cwd: "/p", createdAt: 0 }],
		sessions: [session],
		currentProjectId: "p1",
		currentSessionId: "s1",
	});
	useAgentsStore.setState({
		list: [],
		configs: { dev: agent("dev") },
	} as any);
	useSessionStore.setState({
		messagesBySession: {},
		streamingBySession: {},
		statusBySession: {},
		optimisticEchoBySession: {},
		queueBySession: {},
	} as any);
});

function dispatchPiCommand(text: string): void {
	act(() => {
		window.dispatchEvent(
			new CustomEvent("wa-pi:pi-command", { detail: { text } }),
		);
	});
}

test("pi 斜杠命令：thinking 按当前模型记录取值（优先于会话旧值）", async () => {
	// 会话存着旧模型时期的 high；当前模型的记录是 max
	useComposerPrefsStore.setState({
		bySession: { s1: { model: "p/m1", thinking: "high", attachments: [] } },
		defaults: { model: "p/m1", thinkingByModel: { "p/m1": "max" } },
		loadedBySession: { s1: true },
	} as any);

	render(<App />);
	await act(async () => {});
	dispatchPiCommand("/compact");

	await waitFor(() => {
		const req = postCalls.filter((c) => c.url.includes("/prompt")).at(-1);
		expect(req?.body).toMatchObject({
			model: "p/m1",
			thinking: "max", // 模型记录优先，不是会话里的 high
		});
	});
});

test("pi 斜杠命令：模型无记录且会话也未设过 → default", async () => {
	// 真实的「切到没设置过的模型」状态：setSessionModel 已把会话 thinking 重算成 default，
	// 模型表里也没有该模型的记录。
	useComposerPrefsStore.setState({
		bySession: { s1: { model: "p/m2", thinking: "default", attachments: [] } },
		defaults: { model: "p/m2", thinkingByModel: {} },
		loadedBySession: { s1: true },
	} as any);

	render(<App />);
	await act(async () => {});
	dispatchPiCommand("/compact");

	await waitFor(() => {
		const req = postCalls.filter((c) => c.url.includes("/prompt")).at(-1);
		expect(req?.body?.thinking).toBe("default");
	});
});
