import "./mock-composer-db";
import { test, expect, mock, beforeEach } from "bun:test";
import {
	render,
	screen,
	fireEvent,
	waitFor,
	act,
} from "@testing-library/react";
import type { AgentConfig } from "@wa-pi/shared";

// mock 原生 fetch：App 挂载/会话切换时 SessionView 会 fetch /api/sessions/:id/messages，
// happy-dom 对相对 URL 抛 NotSupportedError，必须替换为返回合法结构（与 ComposerInput.test 同模式）
const originalFetch = globalThis.fetch;
const fetchMock = mock((input: any) => {
	const url = String(input);
	if (url.includes("/messages")) {
		return Promise.resolve({
			ok: true,
			json: () => Promise.resolve({ messages: [], isActive: false }),
		} as any);
	}
	return originalFetch(input);
}) as any;

const calls: { method: string; path: string; body?: any }[] = [];

mock.module("../src/api-client", () => ({
	api: {
		// get 返回 null（falsy）：App mount 时各 store.loadAll/load 的 if(data) 分支不触发，
		// 避免异步覆盖测试在 beforeEach 预设的 store 状态（agents/projects 等）。
		// 例外：/messages 路径（SessionView 挂载时读取会话历史）需要合法结构，否则 res.messages 崩溃。
		get: (path: string) => {
			calls.push({ method: "get", path });
			if (path.includes("/messages")) {
				return Promise.resolve({
					messages: [],
					isActive: false,
					thinkingSince: null,
				});
			}
			return Promise.resolve(null);
		},
		post: (path: string, body?: any) => {
			calls.push({ method: "post", path, body });
			return Promise.resolve({});
		},
		put: (path: string, body?: any) => {
			calls.push({ method: "put", path, body });
			return Promise.resolve({});
		},
		del: (path: string, body?: any) => {
			calls.push({ method: "del", path, body });
			return Promise.resolve({});
		},
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

// 隔离 SSE 事件总线，避免多文件共享 events.ts 模块导致 handler 注册/清理交叉污染
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

const project = { id: "p1", name: "P", cwd: "/p", createdAt: 0 };

const emitEvent = (e: any) => {
	eventHandlers.forEach((h) => h(e));
};

beforeEach(() => {
	calls.length = 0;
	eventHandlers.clear();
	globalThis.fetch = fetchMock; // 会话视图 fetch messages 走 mock，避免 happy-dom 相对 URL 抛错
	// 有项目无会话 → 默认落在 new-session 视图
	useProjectsStore.setState({
		projects: [project],
		sessions: [],
		currentProjectId: "p1",
		currentSessionId: null,
	});
	useAgentsStore.setState({ list: [], configs: {} });
});

test("挂载时请求 agent:list；收到 agent:list 事件写入 agents store", async () => {
	render(<App />);
	await act(async () => {});
	expect(
		calls.some((c) => c.method === "get" && c.path === "/api/agents"),
	).toBe(true);
	act(() => {
		emitEvent({ type: "agent:list", agents: [agent("技术实现")] });
	});
	expect(useAgentsStore.getState().list.map((a) => a.displayName)).toEqual([
		"技术实现",
	]);
});

test("侧栏点智能体 → 新建会话视图且下拉预选该智能体", async () => {
	useAgentsStore.setState({ list: [agent("技术实现"), agent("代码审查")] });
	render(<App />);
	await act(async () => {});
	// 初始默认第一项
	expect(screen.getByTestId("agent-select").textContent).toContain("技术实现");
	fireEvent.click(screen.getByTestId("agent-代码审查"));
	await waitFor(() => {
		expect(screen.getByTestId("agent-select").textContent).toContain(
			"代码审查",
		);
	});
});

test("侧栏「更多智能体」→ 打开宫格；点卡片 → 关宫格并预选", async () => {
	useAgentsStore.setState({
		list: [agent("a1"), agent("a2"), agent("a3"), agent("代码审查")],
	});
	render(<App />);
	await act(async () => {});
	fireEvent.click(screen.getByTestId("agent-more"));
	expect(screen.getByTestId("agent-gallery")).toBeTruthy();
	fireEvent.click(screen.getByTestId("gallery-card-代码审查"));
	await waitFor(() => {
		expect(screen.queryByTestId("agent-gallery")).toBeNull();
	});
	expect(screen.getByTestId("agent-select").textContent).toContain("代码审查");
});

test("侧栏右键「编辑智能体」→ 打开 AgentConfig 弹窗", async () => {
	useAgentsStore.setState({ list: [agent("技术实现")] });
	render(<App />);
	await act(async () => {});
	fireEvent.contextMenu(screen.getByTestId("agent-技术实现"));
	fireEvent.click(screen.getByTestId("agent-ctx-edit"));
	await waitFor(() => expect(screen.getByTestId("agent-config")).toBeTruthy());
});

test("宫格新建成功 → 关宫格并打开新智能体配置弹窗（乐观打开契约）", async () => {
	useAgentsStore.setState({
		list: [agent("a1"), agent("a2"), agent("a3"), agent("a4")],
	});
	render(<App />);
	await act(async () => {});
	fireEvent.click(screen.getByTestId("agent-more"));
	fireEvent.click(screen.getByTestId("gallery-create"));
	fireEvent.change(screen.getByTestId("gallery-create-input"), {
		target: { value: "新助手" },
	});
	fireEvent.click(screen.getByTestId("gallery-create-ok"));
	await waitFor(() => {
		expect(screen.queryByTestId("agent-gallery")).toBeNull();
		expect(screen.getByTestId("agent-config")).toBeTruthy();
	});
	// 配置弹窗头展示新智能体名（draft 未回时回退 agentName；未知名的回退 label 也是它，故多处匹配）
	expect(screen.getAllByText("新助手").length).toBeGreaterThanOrEqual(1);
});

test("pendingAgent 首次消费后清除：离开再进新建页不再预选旧值", async () => {
	useAgentsStore.setState({ list: [agent("技术实现"), agent("代码审查")] });
	// 无项目 → empty 视图（NewSessionPane 未挂载）
	useProjectsStore.setState({ projects: [], currentProjectId: null });
	render(<App />);
	await act(async () => {});
	// empty 视图点侧栏智能体 → 切新建页，pane 首次挂载并消费 pendingAgent
	fireEvent.click(screen.getByTestId("agent-代码审查"));
	await waitFor(() => {
		expect(screen.getByTestId("agent-select").textContent).toContain(
			"代码审查",
		);
	});
	// 给项目再清空（projects.length 变化驱动派生视图）：empty 视图，pane 卸载
	act(() => {
		useProjectsStore.setState({ projects: [project], currentProjectId: "p1" });
	});
	act(() => {
		useProjectsStore.setState({ projects: [], currentProjectId: null });
	});
	await waitFor(() => expect(screen.queryByTestId("agent-select")).toBeNull());
	// 回到新建页（恢复项目，pane 重新挂载）：pendingAgent 已消费清除，应回落列表第一项
	act(() => {
		useProjectsStore.setState({ projects: [project], currentProjectId: "p1" });
	});
	await waitFor(() => expect(screen.getByTestId("agent-select")).toBeTruthy());
	expect(screen.getByTestId("agent-select").textContent).toContain("技术实现");
});

test("extension:commands:changed 事件 → 当前会话 / 菜单命令列表重新拉取", async () => {
	// 挂载时无当前会话（避免 App 挂载触发原生 fetch messages，与既有测试一致）
	useProjectsStore.setState({
		projects: [project],
		sessions: [
			{
				id: "s1",
				projectId: "p1",
				primaryAgent: "dev",
				title: "T",
				createdAt: 0,
				lastActivity: 0,
				piSessionFile: "/tmp/s1.jsonl",
			},
		],
		currentProjectId: "p1",
		currentSessionId: null,
	});
	render(<App />);
	await act(async () => {});
	calls.length = 0; // 清掉挂载期的拉取记录，聚焦事件触发后的刷新

	// 模拟用户已在会话界面：事件到达前 currentSessionId 已是 s1
	act(() => {
		useProjectsStore.setState({ currentSessionId: "s1" });
		emitEvent({ type: "extension:commands:changed" });
	});
	await act(async () => {});
	// 重新拉取当前会话命令列表（load 是异步 fire-and-forget，用 waitFor 等 api.get 被调用）
	await waitFor(() => {
		expect(
			calls.some(
				(c) => c.method === "get" && c.path === "/api/sessions/s1/commands",
			),
		).toBe(true);
	});
});

test("重试期间顶部显示黄色重试条（优先于红色异常条），重试结束回到红条", async () => {
	useProjectsStore.setState({ currentSessionId: "s1" });
	useSessionStore.setState({
		netStatusBySession: { s1: "degraded" },
		retryBySession: { s1: { attempt: 1, maxAttempts: 3 } },
	});
	render(<App />);
	await act(async () => {});
	// 重试中：黄条显示 (1/3)，红色异常条被压制
	const bar = screen.getByTestId("retry-status-bar");
	expect(bar.textContent).toContain("正在自动重试 (1/3)");
	expect(screen.queryByTestId("net-status-bar")).toBeNull();
	// 重试结束（耗尽/中止）：黄条消失，红色异常条恢复
	act(() => {
		useSessionStore.setState({ retryBySession: {} });
	});
	expect(screen.queryByTestId("retry-status-bar")).toBeNull();
	expect(screen.getByTestId("net-status-bar")).toBeTruthy();
});
