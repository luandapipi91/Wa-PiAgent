import "./mock-composer-db";
import { composerDbNewSessionIds } from "./mock-composer-db";
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

// /messages 响应的 isActive 可覆写：描述"会话运行中"的测试（自动重试等）需置 true，
// 否则 setActiveStatus 对齐会把预设的 retryBySession/thinking 复位（isActive=false 语义）。
let mockIsActive = false;

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
					isActive: mockIsActive,
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
import { useBrowserStore } from "../src/store/browser";

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
	mockIsActive = false;
	globalThis.fetch = fetchMock; // 会话视图 fetch messages 走 mock，避免 happy-dom 相对 URL 抛错
	// 有项目无会话 → 默认落在 new-session 视图
	useProjectsStore.setState({
		projects: [project],
		sessions: [],
		currentProjectId: "p1",
		currentSessionId: null,
	});
	useAgentsStore.setState({ list: [], configs: {} });
	// 重置会话级状态条字段（net/retry），避免上一用例残留污染（黄条/红条互斥渲染）
	useSessionStore.setState({
		netStatusBySession: {},
		netMessageBySession: {},
		retryBySession: {},
	});
});

test("挂载时请求 agent:list；收到 agent:list 事件写入 agents store", async () => {
	render(<App />);
	await act(async () => {});
	expect(calls.some((c) => c.method === "get" && c.path === "/api/agents")).toBe(
		true,
	);
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
	// 侧栏已折叠为「智能体 n ›」：点开宫格再点卡片完成预选
	fireEvent.click(screen.getByTestId("agent-collapsed"));
	fireEvent.click(screen.getByTestId("gallery-card-代码审查"));
	await waitFor(() => {
		expect(screen.getByTestId("agent-select").textContent).toContain("代码审查");
	});
});

test("侧栏折叠栏 → 打开宫格；点卡片 → 关宫格并预选", async () => {
	useAgentsStore.setState({
		list: [agent("a1"), agent("a2"), agent("a3"), agent("代码审查")],
	});
	render(<App />);
	await act(async () => {});
	// 旧「更多智能体」入口已随折叠移除，统一走折叠栏
	expect(screen.queryByTestId("agent-more")).toBeNull();
	fireEvent.click(screen.getByTestId("agent-collapsed"));
	expect(screen.getByTestId("agent-gallery")).toBeTruthy();
	fireEvent.click(screen.getByTestId("gallery-card-代码审查"));
	await waitFor(() => {
		expect(screen.queryByTestId("agent-gallery")).toBeNull();
	});
	expect(screen.getByTestId("agent-select").textContent).toContain("代码审查");
});

test("宫格右键「编辑智能体」→ 打开 AgentConfig 弹窗", async () => {
	useAgentsStore.setState({ list: [agent("技术实现")] });
	render(<App />);
	await act(async () => {});
	// 侧栏右键入口已随折叠移除，编辑统一在宫格里触发
	fireEvent.click(screen.getByTestId("agent-collapsed"));
	fireEvent.contextMenu(screen.getByTestId("gallery-card-技术实现"));
	fireEvent.click(screen.getByTestId("gallery-ctx-edit"));
	await waitFor(() => expect(screen.getByTestId("agent-config")).toBeTruthy());
});

test("宫格新建成功 → 编辑弹窗叠加打开，列表保持显示（不自动关）", async () => {
	useAgentsStore.setState({
		list: [agent("a1"), agent("a2"), agent("a3"), agent("a4")],
	});
	render(<App />);
	await act(async () => {});
	fireEvent.click(screen.getByTestId("agent-collapsed"));
	fireEvent.click(screen.getByTestId("gallery-create"));
	// 新建流程走 AgentCreatePicker（宫格场景默认预设 Tab，切到空白创建）
	fireEvent.click(await screen.findByTestId("picker-tab-blank"));
	fireEvent.change(await screen.findByTestId("blank-name-input"), {
		target: { value: "新助手" },
	});
	fireEvent.click(screen.getByTestId("blank-create-btn"));
	await waitFor(() => {
		expect(screen.getByTestId("agent-config")).toBeTruthy();
		// 列表弹窗不自动关闭
		expect(screen.getByTestId("agent-gallery")).toBeTruthy();
	});
	// 配置弹窗头展示新智能体名（draft 未回时回退 agentName；未知名的回退 label 也是它，故多处匹配）
	expect(screen.getAllByText("新助手").length).toBeGreaterThanOrEqual(1);
});

test("宫格里编辑智能体 → 编辑弹窗叠加显示，列表保持打开", async () => {
	useAgentsStore.setState({
		list: [agent("技术实现"), agent("a2"), agent("a3"), agent("a4")],
	});
	render(<App />);
	await act(async () => {});
	fireEvent.click(screen.getByTestId("agent-collapsed"));
	await act(async () => {});
	expect(screen.getByTestId("agent-gallery")).toBeTruthy();

	// 宫格里点「编辑智能体」→ 编辑弹窗打开，列表不关闭
	fireEvent.contextMenu(screen.getByTestId("gallery-card-技术实现"));
	fireEvent.click(screen.getByTestId("gallery-ctx-edit"));
	await act(async () => {});

	expect(screen.getByTestId("agent-config")).toBeTruthy();
	expect(screen.getByTestId("agent-gallery")).toBeTruthy();
});

test("pendingAgent 首次消费后清除：离开再进新建页不再预选旧值", async () => {
	useAgentsStore.setState({ list: [agent("技术实现"), agent("代码审查")] });
	// 无项目 → empty 视图（NewSessionPane 未挂载）
	useProjectsStore.setState({ projects: [], currentProjectId: null });
	render(<App />);
	await act(async () => {});
	// empty 视图点侧栏折叠栏 → 宫格 → 点卡片预选，切新建页，pane 首次挂载并消费 pendingAgent
	fireEvent.click(screen.getByTestId("agent-collapsed"));
	fireEvent.click(screen.getByTestId("gallery-card-代码审查"));
	await waitFor(() => {
		expect(screen.getByTestId("agent-select").textContent).toContain("代码审查");
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

test("extension:changed 事件（安装/卸载/升级）→ 当前会话 / 菜单命令列表立即刷新", async () => {
	// 与 extension:commands:changed 同场景：安装/卸载/升级插件后，
	// kernel 广播 extension:changed，前端应立即重拉当前会话命令清单
	// （kernel getCommands 脏感知：idle 脏会话先重建 pi 进程再返回新清单，当前对话即时生效）
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
	calls.length = 0;

	act(() => {
		useProjectsStore.setState({ currentSessionId: "s1" });
		emitEvent({ type: "extension:changed", packages: [] });
	});
	await act(async () => {});
	await waitFor(() => {
		expect(
			calls.some(
				(c) => c.method === "get" && c.path === "/api/sessions/s1/commands",
			),
		).toBe(true);
	});
});

test("第三次重试起（attempt≥3）顶部显示黄色重试条（优先于红色异常条），重试结束回到红条", async () => {
	useProjectsStore.setState({ currentSessionId: "s1" });
	// 自动重试中的会话是运行态：/messages 响应需 isActive=true，
	// 否则 setActiveStatus 对齐会清掉 retryBySession（黄条消失）
	mockIsActive = true;
	useSessionStore.setState({
		netStatusBySession: { s1: "degraded" },
		// attempt=3：第三次起才显示重试进度文案（前两次不显示进度，见下一用例）
		retryBySession: { s1: { attempt: 3, maxAttempts: 4 } },
	});
	render(<App />);
	await act(async () => {});
	// 重试中：黄条显示 (3/4)，红色异常条被压制
	const bar = screen.getByTestId("retry-status-bar");
	expect(bar.textContent).toContain("正在自动重试 (3/4)");
	expect(screen.queryByTestId("net-status-bar")).toBeNull();
	// 重试结束（耗尽/中止）：黄条消失，红色异常条恢复
	act(() => {
		useSessionStore.setState({ retryBySession: {} });
	});
	expect(screen.queryByTestId("retry-status-bar")).toBeNull();
	expect(screen.getByTestId("net-status-bar")).toBeTruthy();
});

test("第一次重试（attempt=1）不显示重试进度，显示「服务器繁忙，请等待」", async () => {
	useProjectsStore.setState({ currentSessionId: "s1" });
	mockIsActive = true;
	useSessionStore.setState({
		netStatusBySession: { s1: "degraded" },
		retryBySession: { s1: { attempt: 1, maxAttempts: 3 } },
	});
	render(<App />);
	await act(async () => {});
	const bar = screen.getByTestId("retry-status-bar");
	expect(bar.textContent).toContain("当前请求服务器繁忙，请等待");
	expect(bar.textContent).not.toContain("正在自动重试");
});

test("第二次重试（attempt=2）同样不显示重试进度，显示「服务器繁忙，请等待」", async () => {
	useProjectsStore.setState({ currentSessionId: "s1" });
	mockIsActive = true;
	useSessionStore.setState({
		retryBySession: { s1: { attempt: 2, maxAttempts: 3 } },
	});
	render(<App />);
	await act(async () => {});
	const bar = screen.getByTestId("retry-status-bar");
	expect(bar.textContent).toContain("当前请求服务器繁忙，请等待");
	expect(bar.textContent).not.toContain("正在自动重试");
});

test("net:status 携带具体原因时红色状态条显示该原因（而非通用文案）", async () => {
	useProjectsStore.setState({ currentSessionId: "s1" });
	render(<App />);
	await act(async () => {});
	act(() => {
		emitEvent({
			type: "net:status",
			status: "degraded",
			message: "请求过于频繁（429），请稍后重试",
			sessionId: "s1",
		});
	});
	const bar = screen.getByTestId("net-status-bar");
	expect(bar.textContent).toContain("请求过于频繁（429），请稍后重试");
});

test("net:status 无具体原因时红色状态条回落通用文案", async () => {
	useProjectsStore.setState({ currentSessionId: "s1" });
	useSessionStore.setState({
		netStatusBySession: { s1: "degraded" },
		netMessageBySession: {},
	});
	render(<App />);
	await act(async () => {});
	expect(screen.getByTestId("net-status-bar").textContent).toContain(
		"模型连接异常",
	);
});

test("扩展 setTitle → 聊天窗顶部标题条", async () => {
	useProjectsStore.setState({ currentSessionId: "s1" });
	useSessionStore.setState({
		extTitleBySession: { s1: "pi-lens 分析中" },
	});
	render(<App />);
	await act(async () => {});
	expect(screen.getByTestId("ext-title-bar").textContent).toContain(
		"pi-lens 分析中",
	);
});

test("扩展 setTitle 的 ANSI 颜色解析为内联样式", async () => {
	useProjectsStore.setState({ currentSessionId: "s1" });
	useSessionStore.setState({
		extTitleBySession: { s1: "\x1b[31m告警\x1b[39m pi-lens 分析中" },
	});
	render(<App />);
	await act(async () => {});
	const bar = screen.getByTestId("ext-title-bar");
	const colored = screen.getByText("告警");
	expect(colored.style.color).toBe("#dc2626");
	expect(bar.textContent).toBe("告警 pi-lens 分析中");
	expect(bar.textContent).not.toContain("\x1b");
});

test("session:activated（预热完成）触发重拉 stats，补齐占比胶囊数据", async () => {
	render(<App />);
	await act(async () => {});
	calls.length = 0; // 清掉挂载期拉取，聚焦事件触发后的请求

	act(() => {
		emitEvent({ type: "session:activated", sessionId: "s1" });
	});
	await act(async () => {});

	// refreshSessionStats 只拉 /stats（不动消息列表）
	await waitFor(() => {
		expect(
			calls.some((c) => c.method === "get" && c.path === "/api/sessions/s1/stats"),
		).toBe(true);
	});
	expect(
		calls.some(
			(c) => c.method === "get" && c.path === "/api/sessions/s1/messages",
		),
	).toBe(false);
});

test("处于新建会话/空视图时，已打开的预览应被关闭（切走不残留）", async () => {
	// 预设：某个会话打开了预览（open=true），但当前界面处于无会话状态（new-session 视图）。
	// 修复前根因：切到 new-session / empty 视图时 App 层没调 activateSession(null) 关闭预览，
	// 导致 BrowserPanel 因 open=true 仍挂载 → 预览在新建会话页残留。
	useBrowserStore.setState({
		open: true,
		path: "/a/index.html",
		sessionId: "A",
	});

	render(<App />);
	await act(async () => {});

	// 无会话 → new-session 视图：新建页自身无预览记忆（fallback 空预览），预览应被关闭
	expect(useBrowserStore.getState().open).toBe(false);
	expect(useBrowserStore.getState().path).toBeNull();
});

test("切回新建会话页时，新建页此前打开的预览应恢复（不被 App 层的关闭覆盖）", async () => {
	// 新建页锚点（同草稿 newSessionKey 持久化）：此前打开过预览，被 bySession 记住。
	// 用共享 mock 的 newSessionIds 让 NewSessionPane 挂载时 sid 固定为 anchor（否则读到随机 sid）。
	const anchor = "draft-session-anchor";
	composerDbNewSessionIds["p1"] = anchor;
	useBrowserStore.setState({
		open: false,
		path: null,
		sessionId: null,
		bySession: {
[anchor]: { open: true, path: "/a/index.html", minimized: false },
		},
	});

	render(<App />);
	await act(async () => {});

	// 切到新建会话页：新建页锚点有预览记忆 → 应恢复 open=true（App 层不再用 null 覆盖）
	expect(useBrowserStore.getState().open).toBe(true);
	expect(useBrowserStore.getState().path).toBe("/a/index.html");
	expect(useBrowserStore.getState().sessionId).toBe(anchor);
});
