import "./mock-composer-db";
import { test, expect, beforeEach, mock, afterEach } from "bun:test";
import {
	render,
	screen,
	waitFor,
	act,
	fireEvent,
	cleanup,
} from "@testing-library/react";
import { SYSTEM_PROJECT_ID, type SessionMessage } from "@wa-pi/shared";
import { SessionView } from "../src/components/SessionView";
import { VirtuosoMockContext } from "react-virtuoso";
import { useProjectsStore } from "../src/store/projects";
import { useSessionStore } from "../src/store/session";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { useProvidersStore } from "../src/store/providers";
import { composerDbDefaults, composerDbSessions } from "./mock-composer-db";
import { disconnectEvents } from "../src/events";

// 记录所有 REST API 调用，替代原 WebSocket sentEvents。
const apiCalls: { method: string; path: string; body?: any }[] = [];

// 控制 /messages GET 的异步解析，用于验证加载指示的显隐。
let messagesDeferred: {
	promise: Promise<{
		messages: SessionMessage[];
		isActive?: boolean;
		thinkingSince?: number | null;
	}>;
	resolve: (value: {
		messages: SessionMessage[];
		isActive?: boolean;
		thinkingSince?: number | null;
	}) => void;
	reject: (reason?: any) => void;
} | null = null;

function deferMessages() {
	let resolve!: (value: {
		messages: SessionMessage[];
		isActive?: boolean;
		thinkingSince?: number | null;
	}) => void;
	let reject!: (reason?: any) => void;
	const promise = new Promise<{
		messages: SessionMessage[];
		isActive?: boolean;
		thinkingSince?: number | null;
	}>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	messagesDeferred = { promise, resolve, reject };
	return messagesDeferred;
}

mock.module("../src/api-client", () => ({
	api: {
		get: (path: string) => {
			apiCalls.push({ method: "get", path });
			if (path.includes("/messages")) {
				return messagesDeferred?.promise ?? Promise.resolve({ messages: [] });
			}
			return Promise.resolve({});
		},
		post: (path: string, body?: any) => {
			apiCalls.push({ method: "post", path, body });
			return Promise.resolve({});
		},
		put: (path: string, body?: any) => {
			apiCalls.push({ method: "put", path, body });
			return Promise.resolve({});
		},
		del: (path: string) => {
			apiCalls.push({ method: "del", path });
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

// 渲染后清理 DOM：happy-dom 全局 document 跨测试文件共享，不清理会污染后续文件
afterEach(() => cleanup());

beforeEach(() => {
	disconnectEvents();
	apiCalls.length = 0;
	messagesDeferred = null;

	// composer-db 默认值重置，避免 Composer 异步加载覆盖测试状态。
	composerDbDefaults.model = "openai/gpt-4o";
	composerDbDefaults.thinking = "disabled";
	for (const k of Object.keys(composerDbSessions)) delete composerDbSessions[k];

	useProjectsStore.setState({
		projects: [{ id: "p1", name: "P", cwd: "/work/p1", createdAt: 0 }],
		sessions: [
			{
				id: "s1",
				projectId: "p1",
				primaryAgent: "dev",
				title: "测试",
				createdAt: 0,
				lastActivity: 0,
				piSessionFile: "",
			},
		],
		currentProjectId: "p1",
		currentSessionId: "s1",
	});
	useSessionStore.setState({
		messagesBySession: {},
		lastUsageBySession: {},
		tokenTotals: {},
		contextUsageBySession: {},
	});
	// 重置 composer-prefs 和 providers，防止测试间状态泄漏
	useComposerPrefsStore.setState({
		bySession: {},
		defaults: { model: null, thinking: "disabled" },
	});
	useProvidersStore.setState({ providers: [] });
});

// 渲染并等待异步 effect（composer-prefs loadSession、api.get 等）落定，
// 减少 React act 警告。
async function renderSessionView(sessionId: string) {
	const result = render(
		<VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 60 }}>
			<SessionView sessionId={sessionId} />
		</VirtuosoMockContext.Provider>,
	);
	await act(async () => {});
	return result;
}

test("渲染 header 标题 + 项目目录", async () => {
	await renderSessionView("s1");
	expect(screen.getByText("测试")).toBeTruthy();
	expect(screen.getByText(/\/work\/p1/)).toBeTruthy();
});

test("header 状态显示中文「空闲」，不暴露英文枚举", async () => {
	await renderSessionView("s1");
	expect(screen.getByText(/· 空闲/)).toBeTruthy();
	expect(screen.queryByText(/· idle/)).toBeNull();
	// 状态点：idle 成功绿
	expect(
		(
			screen.getByTestId("session-status-dot") as HTMLElement
		).style.background.toLowerCase(),
	).toBe("#34a853");
});

test("header 状态跟随会话运行态显示「思考中」", async () => {
	useSessionStore.setState({ statusBySession: { s1: "thinking" } });
	await renderSessionView("s1");
	expect(screen.getByText(/· 思考中/)).toBeTruthy();
	expect(screen.queryByText(/· thinking/)).toBeNull();
	// 状态点：thinking 靛蓝
	expect(
		(
			screen.getByTestId("session-status-dot") as HTMLElement
		).style.background.toLowerCase(),
	).toBe("#5b5bd6");
});

test("有 pending ask 时 header 状态显示「等待回复」", async () => {
	const askCall = {
		type: "toolCall",
		id: "tc-ask-2",
		name: "ask_user_question",
		arguments: {
			questions: [
				{
					question: "Q?",
					header: "h",
					options: [
						{ label: "A", description: "x" },
						{ label: "B", description: "y" },
					],
				},
			],
		},
	};
	useSessionStore.getState().setMessages("s1", [
		{
			agentName: "dev",
			message: {
				role: "assistant",
				content: [askCall],
				model: "pi-test",
				stopReason: "tool_use",
				timestamp: 1,
			} as any,
		},
	]);
	await renderSessionView("s1");
	expect(screen.getByText(/· 等待回复/)).toBeTruthy();
	expect(screen.queryByText(/· blocked/)).toBeNull();
	// 状态点：blocked 警告橙
	expect(
		(
			screen.getByTestId("session-status-dot") as HTMLElement
		).style.background.toLowerCase(),
	).toBe("#b45309");
});

test("收到 session:messages 响应后填充历史消息", () => {
	// 直接测 store 的 setMessages（SessionView 收到 GET /messages 响应后调它）
	// SessionMessage 形态：message 为 Pi 原生消息（带 role/timestamp），非旧 ChatMessage
	const history: SessionMessage[] = [
		{
			agentName: undefined,
			message: { role: "user", content: "历史问题", timestamp: 1 },
		},
		{
			agentName: "dev",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "历史回复" }],
				model: "pi-test",
				stopReason: "end_turn",
				timestamp: 2,
			},
		},
	];
	useSessionStore.getState().setMessages("s1", history);
	const msgs = useSessionStore.getState().messagesBySession["s1"];
	expect(msgs).toHaveLength(2);
	const first = msgs[0].message as any;
	expect(first.role).toBe("user");
	expect(first.content).toBe("历史问题");
});

test("首次进入会话历史未到时显示加载指示，响应到达后消失", async () => {
	const deferred = deferMessages();
	await renderSessionView("s1");
	// 发出 GET /messages 后、历史未到 → 对话区显示 loading
	await screen.findByTestId("history-loading-s1");

	// 模拟 REST 响应：解析延迟的 messages promise
	const history: SessionMessage[] = [
		{
			agentName: undefined,
			message: { role: "user", content: "历史问题", timestamp: 1 },
		},
	];
	await act(async () => {
		deferred.resolve({ messages: history });
	});

	// 响应到达 → 加载消失、历史消息出现
	await waitFor(() => {
		expect(screen.queryByTestId("history-loading-s1")).toBeNull();
		expect(screen.getByText("历史问题")).toBeTruthy();
	});
	// store 标志同步清掉
	expect(useSessionStore.getState().historyLoadingBySession["s1"]).toBe(false);
});

test("会话已有消息时进入不显示历史加载（避免刷新闪烁）", async () => {
	// 预置 s1 已有历史消息（模拟再次进入已访问过的会话）
	useSessionStore.getState().setMessages("s1", [
		{
			agentName: undefined,
			message: { role: "user", content: "已存在", timestamp: 1 },
		},
	]);
	await renderSessionView("s1");
	// 有消息则即便 loading 标志为 true 也不显示加载指示
	await waitFor(() => {
		expect(screen.queryByTestId("history-loading-s1")).toBeNull();
		expect(screen.getByText("已存在")).toBeTruthy();
	});
});

test("运行中时排队消息隐藏「立即」按钮，保留「引导」按钮", async () => {
	useSessionStore.setState({
		statusBySession: { s1: "thinking" },
		queueBySession: { s1: { steering: [], followUp: ["排队消息"] } },
	});
	await renderSessionView("s1");
	expect(screen.getByTestId("btn-promote")).toBeTruthy();
	expect(screen.queryByTestId("btn-immediate")).toBeNull();
});

test("空闲时排队消息显示「立即」按钮", async () => {
	useSessionStore.setState({
		statusBySession: { s1: "idle" },
		queueBySession: { s1: { steering: [], followUp: ["排队消息"] } },
	});
	await renderSessionView("s1");
	expect(screen.getByTestId("btn-immediate")).toBeTruthy();
	expect(screen.getByTestId("btn-promote")).toBeTruthy();
});

test("点击引导按钮发送 steer 请求 + 乐观更新", async () => {
	useSessionStore.setState({
		statusBySession: { s1: "idle" },
		queueBySession: { s1: { steering: [], followUp: ["消息A", "消息B"] } },
	});
	await renderSessionView("s1");

	const btn = screen.getAllByTestId("btn-promote")[0];
	await act(async () => {
		btn.click();
	});

	// API 调用：新版仅发 text，不含 remainingTexts
	const calls = apiCalls.filter(
		(c) => c.method === "post" && c.path === "/api/sessions/s1/steer",
	);
	expect(calls).toHaveLength(1);
	expect(calls[0].body).toEqual({ text: "消息A" });

	// 乐观更新：消息从排队区移到引导区
	const state = useSessionStore.getState();
	expect(state.queueBySession["s1"]!.steering).toContain("消息A");
	expect(state.queueBySession["s1"]!.followUp).toEqual(["消息B"]);
});

test("点击立即按钮发送 steer:immediate 请求", async () => {
	useSessionStore.setState({
		statusBySession: { s1: "idle" },
		queueBySession: { s1: { steering: [], followUp: ["消息A", "消息B"] } },
	});
	await renderSessionView("s1");
	const btn = screen.getAllByTestId("btn-immediate")[0];
	await act(async () => {
		btn.click();
	});
	const calls = apiCalls.filter(
		(c) => c.method === "post" && c.path === "/api/sessions/s1/steer/immediate",
	);
	expect(calls).toHaveLength(1);
	expect(calls[0].body).toEqual({ text: "消息A" });
});

test("点击清空排队按钮立即清空 followUp 列表", async () => {
	useSessionStore.setState({
		statusBySession: { s1: "idle" },
		queueBySession: {
			s1: { steering: ["引导中消息"], followUp: ["排队1", "排队2"] },
		},
	});
	await renderSessionView("s1");

	// 清空前：排队消息可见
	expect(screen.getByText("排队 2 条")).toBeTruthy();

	const clearBtn = screen.getByTestId("btn-clear-queue");
	await act(async () => {
		clearBtn.click();
	});

	// 乐观更新：followUp 立即清空，steering 不受影响
	const state = useSessionStore.getState();
	expect(state.queueBySession["s1"]!.followUp).toEqual([]);
	expect(state.queueBySession["s1"]!.steering).toEqual(["引导中消息"]);
});
test("GET /messages 返回 isActive=false 时不清除本地乐观 thinking（核心回归测试）", async () => {
	// 场景：新建会话发送消息 → echo_user 已到 → optimisticSend 设 status=thinking。
	// 随后 SessionView mount 的 GET /messages 因冷启动竞态返回 isActive=false。
	// 旧逻辑 setActiveStatus(false) 会清除乐观 thinking → 「正在思考」闪退。
	// 正确行为：isActive=false 不干预 thinking（清除由 SDK 事件 agent_end/failTurn 驱动）。
	useSessionStore.setState({
		statusBySession: { s1: "thinking" },
		thinkingSinceBySession: { s1: 123 },
	});
	const deferred = deferMessages();
	await renderSessionView("s1");

	await act(async () => {
		deferred.resolve({ messages: [], isActive: false, thinkingSince: null });
	});

	const s = useSessionStore.getState();
	expect(s.statusBySession["s1"]).toBe("thinking");
	expect(s.thinkingSinceBySession["s1"]).toBe(123);
});

test("GET /messages 返回 isActive=true 时补设 thinking（打开正在跑的会话）", async () => {
	// 场景：打开一个 agent 正在处理的会话（用户之前发了消息在另一个会话页），
	// GET /messages 返回 isActive=true → 应设 thinking。
	useSessionStore.setState({}); // status 未设（idle）
	const deferred = deferMessages();
	await renderSessionView("s1");

	await act(async () => {
		deferred.resolve({
			messages: [],
			isActive: true,
			thinkingSince: 999,
		});
	});

	const s = useSessionStore.getState();
	expect(s.statusBySession["s1"]).toBe("thinking");
	expect(s.thinkingSinceBySession["s1"]).toBe(999);
});

test("GET /messages 返回 isActive=false 且本地无 thinking 时不新增状态（打开历史会话）", async () => {
	// 场景：打开历史会话（未发消息、无 thinking）→ isActive=false → 不干预
	useSessionStore.setState({ statusBySession: {} }); // 显式清除残留
	const deferred = deferMessages();
	await renderSessionView("s1");

	await act(async () => {
		deferred.resolve({ messages: [], isActive: false, thinkingSince: null });
	});

	// status 未被设（不新增 idle 键，也不设 thinking）
	expect(useSessionStore.getState().statusBySession["s1"]).toBeUndefined();
});

test("切换会话后思考计时显示对应会话的已思考时长（不重置、不沿用旧会话）", async () => {
	const now = Date.now();
	useProjectsStore.setState({
		projects: [{ id: "p1", name: "P", cwd: "/work/p1", createdAt: 0 }],
		sessions: [
			{
				id: "s1",
				projectId: "p1",
				primaryAgent: "dev",
				title: "t1",
				createdAt: 0,
				lastActivity: 0,
				piSessionFile: "",
			},
			{
				id: "s2",
				projectId: "p1",
				primaryAgent: "dev",
				title: "t2",
				createdAt: 0,
				lastActivity: 0,
				piSessionFile: "",
			},
		],
		currentProjectId: "p1",
		currentSessionId: "s1",
	});
	useSessionStore.setState({
		statusBySession: { s1: "thinking", s2: "thinking" },
		thinkingSinceBySession: { s1: now - 5000, s2: now - 10000 },
	});

	const { rerender } = await renderSessionView("s1");
	// s1 已思考约 5s
	expect(await screen.findByText(/思考中 · (5|6)s/)).toBeTruthy();

	// 切换到 s2：应显示 s2 的约 10s，而不是沿用 s1 的 5s 或重置成 0
	rerender(<SessionView sessionId="s2" />);
	expect(await screen.findByText(/思考中 · (10|11)s/)).toBeTruthy();
});

test("有 pending ask 时渲染 AskDock 且 composer 禁用", async () => {
	// 预置一条带 ask_user_question toolCall 的 assistant 消息（无 toolResult）
	const askCall = {
		type: "toolCall",
		id: "tc-ask-1",
		name: "ask_user_question",
		arguments: {
			questions: [
				{
					question: "Q?",
					header: "h",
					options: [
						{ label: "A", description: "x" },
						{ label: "B", description: "y" },
					],
				},
			],
		},
	};
	const history: SessionMessage[] = [
		{
			agentName: "dev",
			message: {
				role: "assistant",
				content: [askCall],
				model: "pi-test",
				stopReason: "tool_use",
				timestamp: 1,
			} as any,
		},
	];
	useSessionStore.getState().setMessages("s1", history);

	await renderSessionView("s1");
	// dock 渲染
	expect(screen.getByTestId("ask-dock-s1")).toBeTruthy();
	// 表单卡片渲染
	expect(screen.getByTestId("ask-card-tc-ask-1")).toBeTruthy();
	// composer contenteditable 禁用（ask 阻塞）
	const textbox = screen
		.getByTestId("composer-input")
		.querySelector('[role="textbox"]')! as HTMLElement;
	expect(textbox.isContentEditable).toBe(false);
});

test("无 pending ask 时不渲染 AskDock", async () => {
	// 预置普通消息（非 ask toolCall）
	const history: SessionMessage[] = [
		{
			agentName: undefined,
			message: { role: "user", content: "普通问题", timestamp: 1 },
		},
	];
	useSessionStore.getState().setMessages("s1", history);

	await renderSessionView("s1");
	// dock 不存在
	expect(screen.queryByTestId("ask-dock-s1")).toBeNull();
	// composer contenteditable 未禁用
	const textbox = screen
		.getByTestId("composer-input")
		.querySelector('[role="textbox"]')! as HTMLElement;
	expect(textbox.isContentEditable).toBe(true);
});

test("默认工作区会话 header 显示友好文案", async () => {
	// 默认工作区会话：不暴露内部 cwd，显示「默认工作区 · 工作目录」
	useProjectsStore.setState({
		projects: [
			{
				id: SYSTEM_PROJECT_ID,
				name: "默认工作区",
				cwd: "/tmp/workdir",
				createdAt: 0,
			},
		],
		sessions: [
			{
				id: "s1",
				projectId: SYSTEM_PROJECT_ID,
				primaryAgent: "dev",
				title: "设计海报",
				createdAt: 1721000000000,
				lastActivity: Date.now(),
				piSessionFile: "",
			},
		],
		currentProjectId: SYSTEM_PROJECT_ID,
		currentSessionId: "s1",
	});
	await renderSessionView("s1");
	// header 显示友好文案，不暴露 /tmp/workdir
	expect(screen.getByText(/默认工作区/)).toBeTruthy();
	expect(screen.getByText(/工作目录/)).toBeTruthy();
	expect(screen.queryByText(/\/tmp\/workdir/)).toBeNull();
});

test("IM 接入会话：sourceLabel 拼到状态行末尾，不再显示「仅显示最近」提示", async () => {
	await act(async () => {
		render(<SessionView sessionId="s1" sourceLabel={`经「小 co 助手」接入`} />);
	});
	// sourceLabel 跟在状态行末尾，与状态文案同处一段灰色小字（跨 JSX 表达式，断 textContent）
	const statusRow = screen.getByTestId("session-status-dot").parentElement;
	expect(statusRow?.textContent).toContain("经「小 co 助手」接入");
	// 不再有独立的来源徽标组和历史条数提示
	expect(screen.queryByTestId("im-source-badge")).toBeNull();
	expect(screen.queryByText(/仅显示最近/)).toBeNull();
});

// === 回归：React #300（Rendered fewer hooks than expected）===
// 触发链：发送/接收消息时 kernel 广播 projects:list 快照可能滞后（新会话乐观添加后
// placeholder 尚未转正），setAll 替换 sessions 数组但防御逻辑保留 currentSessionId。
// 于是 App 仍渲染 SessionView，而 session = sessions.find(...) 暂时找不到 → undefined。
// SessionView 的 useExplorerStore 曾位于 if (!session) return null 之后：
// session 在/不在两次渲染 hooks 数量 16→14，React 报 #300 崩溃白屏。
test("会话短暂消失（projects:list 快照滞后）不抛 React #300 崩溃", async () => {
	await renderSessionView("s1");
	expect(screen.getByText("测试")).toBeTruthy();

	// 模拟 kernel projects:list 快照滞后：sessions 数组被整体替换（不含 s1），
	// 但 currentSessionId 仍保留（setAll 防御逻辑只清 currentSessionId 不删列表引用）。
	let thrown: unknown = null;
	try {
		await act(async () => {
			useProjectsStore.setState({
				sessions: [],
				currentProjectId: "p1",
				currentSessionId: "s1",
			});
		});
	} catch (e) {
		thrown = e;
	}
	// 修复前：React 抛 "Rendered fewer hooks than expected"（生产构建 #300）
	expect(thrown).toBeNull();
});

test("会话恢复后 SessionView 正常渲染（不残留崩溃状态）", async () => {
	// 先让 session 消失一帧（快照滞后），再恢复
	await act(async () => {
		useProjectsStore.setState({ sessions: [], currentSessionId: "s1" });
	});
	await act(async () => {
		useProjectsStore.setState({
			projects: [{ id: "p1", name: "P", cwd: "/work/p1", createdAt: 0 }],
			sessions: [
				{
					id: "s1",
					projectId: "p1",
					primaryAgent: "dev",
					title: "测试",
					createdAt: 0,
					lastActivity: 0,
					piSessionFile: "",
				},
			],
			currentProjectId: "p1",
			currentSessionId: "s1",
		});
	});
	await renderSessionView("s1");
	expect(screen.getByText("测试")).toBeTruthy();
});

// === 文件树面板（ExplorerPanel）===
// explorer store 状态在测试间共享，需手动重置
const { useExplorerStore } = await import("../src/store/explorer");

test("header 右上角有浏览器预览按钮（btn-browser-preview）", async () => {
	await renderSessionView("s1");
	const btn = screen.getByTestId("btn-browser-preview");
	expect(btn).toBeTruthy();
	// 位于 header 内、btn-explorer 之后
	const header = screen.getByTestId("session-view").querySelector("header");
	expect(header).not.toBeNull();
	expect(header!.contains(btn)).toBe(true);
	expect(
		header!
			.querySelector("button[data-testid='btn-explorer']")!
			.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
});

test("header 含文件树按钮，点击后展开右侧面板", async () => {
	useExplorerStore.getState().setOpen(false);
	await renderSessionView("s1");
	const btn = screen.getByTestId("btn-explorer");
	expect(btn).toBeTruthy();
	// 图标基础尺寸 18px 且跟随 --font-scale 缩放（与 SettingsButton/ProjectItem 同口径）：
	// Icon 组件 size=1em + className 挂 calc(18px*var(--font-scale))
	const svg = btn.querySelector("svg");
	expect(svg?.getAttribute("width")).toBe("1em");
	expect(svg?.getAttribute("height")).toBe("1em");
	expect(svg?.getAttribute("class")).toContain(
		"text-[calc(18px*var(--font-scale))]",
	);

	// 初始面板收起
	expect(screen.queryByTestId("explorer-aside")).toBeNull();

	// 点击展开
	await act(async () => {
		fireEvent.click(screen.getByTestId("btn-explorer"));
	});
	expect(screen.getByTestId("explorer-aside")).toBeTruthy();

	// 再次点击收起
	await act(async () => {
		fireEvent.click(screen.getByTestId("btn-explorer"));
	});
	expect(screen.queryByTestId("explorer-aside")).toBeNull();
});

test("普通项目会话 header 仍显示 project.cwd（不回归）", async () => {
	// 普通项目会话：header 显示真实 cwd，差异化逻辑不影响老行为
	useProjectsStore.setState({
		projects: [{ id: "p1", name: "WaPi", cwd: "/work/wa-pi", createdAt: 0 }],
		sessions: [
			{
				id: "s1",
				projectId: "p1",
				primaryAgent: "dev",
				title: "会话",
				createdAt: 0,
				lastActivity: Date.now(),
				piSessionFile: "",
			},
		],
		currentProjectId: "p1",
		currentSessionId: "s1",
	});
	await renderSessionView("s1");
	// 与现有「渲染 header 标题 + 项目目录」测试一致，用 regex 匹配 cwd 子串
	expect(screen.getByText(/\/work\/wa-pi/)).toBeTruthy();
});

test("token 胶囊：有 usage 时显示 ↑↓/累计/缓存", () => {
	useSessionStore.setState({
		lastUsageBySession: {
			s1: { input: 3200, output: 1100, cacheRead: 1500, cacheWrite: 200 },
		},
		tokenTotals: {
			s1: {
				input: 6400,
				output: 2100,
				cacheRead: 1500,
				cacheWrite: 200,
				total: 10200,
			},
		},
	});
	useProjectsStore.setState({
		sessions: [
			{
				id: "s1",
				projectId: "p1",
				primaryAgent: "dev",
				title: "测试",
				createdAt: 0,
				lastActivity: 0,
				piSessionFile: "/tmp/s1.jsonl",
			},
		],
		projects: [{ id: "p1", name: "test", cwd: "/work/wa-pi", createdAt: 0 }],
	});
	render(<SessionView sessionId="s1" />);
	expect(screen.getByTestId("token-capsules")).toBeTruthy();
	expect(screen.getByText(/本轮: ↑3\.2K\/↓1\.1K/)).toBeTruthy();
	// 累计 = total（含 cacheRead/cacheWrite）：6400+2100+1500+200 = 10200 → 10.2K
	expect(screen.getByText(/累计 10\.2K/)).toBeTruthy();
	// cacheRead/(input+cacheRead+cacheWrite) = 1500/(3200+1500+200) ≈ 30.61% → 30.6%
	expect(screen.getByText(/缓存 30\.6%/)).toBeTruthy();
});

test("token 胶囊：缓存命中率 ≥99.95% 时向下取整显示 99.9%，不显示误导的 100%", () => {
	useSessionStore.setState({
		// 19990/(10+19990+0) = 99.95%——四舍五入会显示 100%，但实际并非 100%
		lastUsageBySession: {
			s1: { input: 10, output: 100, cacheRead: 19990, cacheWrite: 0 },
		},
	});
	useProjectsStore.setState({
		sessions: [
			{
				id: "s1",
				projectId: "p1",
				primaryAgent: "dev",
				title: "测试",
				createdAt: 0,
				lastActivity: 0,
				piSessionFile: "/tmp/s1.jsonl",
			},
		],
		projects: [{ id: "p1", name: "test", cwd: "/work/wa-pi", createdAt: 0 }],
	});
	render(<SessionView sessionId="s1" />);
	expect(screen.getByTestId("token-capsules")).toBeTruthy();
	expect(screen.getByText(/缓存 99\.9%/)).toBeTruthy();
	expect(screen.queryByText(/缓存 100%/)).toBeNull();
});

test("token 胶囊：有 contextUsage 时累计胶囊显示进度条", () => {
	// 占用/进度条只认官方 contextUsage：3200 / 128000 = 2.5% → 宽度 3%
	useSessionStore.setState({
		lastUsageBySession: {
			s1: { input: 3200, output: 1100, cacheRead: 0, cacheWrite: 0 },
		},
		tokenTotals: {
			s1: {
				input: 6400,
				output: 2100,
				cacheRead: 0,
				cacheWrite: 0,
				total: 8500,
			},
		},
		contextUsageBySession: { s1: { used: 3200, total: 128000, ratio: 0.025 } },
	});
	useProjectsStore.setState({
		sessions: [
			{
				id: "s1",
				projectId: "p1",
				primaryAgent: "dev",
				title: "测试",
				createdAt: 0,
				lastActivity: 0,
				piSessionFile: "/tmp/s1.jsonl",
			},
		],
		projects: [{ id: "p1", name: "test", cwd: "/work/wa-pi", createdAt: 0 }],
	});

	render(<SessionView sessionId="s1" />);

	expect(screen.getByTestId("token-capsules")).toBeTruthy();
	// 进度条存在且宽度为 3%（当前窗口占用 3200/128000 四舍五入，与累计 8500 无关）
	const progress = screen.getByTestId("token-progress");
	expect(progress).toBeTruthy();
	const fill = progress.querySelector(".token-progress-fill") as HTMLElement;
	expect(fill.style.width).toBe("3%");
	// 进度条上方显示当前窗口占用 token 数
	expect(screen.getByTestId("token-occupied").textContent).toContain(
		"占用 3.2K",
	);
});

test("token 胶囊：无 contextUsage 时累计胶囊不显示进度条", () => {
	// 无官方占用数据 → 不显示进度条/占用，仅弱化累计（本地估算已移除）
	useSessionStore.setState({
		lastUsageBySession: {
			s1: { input: 3200, output: 1100, cacheRead: 0, cacheWrite: 0 },
		},
		tokenTotals: {
			s1: {
				input: 6400,
				output: 2100,
				cacheRead: 0,
				cacheWrite: 0,
				total: 8500,
			},
		},
	});
	useProjectsStore.setState({
		sessions: [
			{
				id: "s1",
				projectId: "p1",
				primaryAgent: "dev",
				title: "测试",
				createdAt: 0,
				lastActivity: 0,
				piSessionFile: "/tmp/s1.jsonl",
			},
		],
		projects: [{ id: "p1", name: "test", cwd: "/work/wa-pi", createdAt: 0 }],
	});

	render(<SessionView sessionId="s1" />);

	// 胶囊组仍显示（有 lastUsage），进度条与「占用」不应存在，仅显示弱化累计
	expect(screen.getByTestId("token-capsules")).toBeTruthy();
	expect(screen.getByText(/本轮: ↑3\.2K\/↓1\.1K/)).toBeTruthy();
	expect(screen.getByText(/累计 8\.5K/)).toBeTruthy();
	expect(screen.queryByTestId("token-progress")).toBeNull();
	expect(screen.queryByTestId("token-occupied")).toBeNull();
});

test("token 胶囊：进度条极小占比也有最小可见宽度", () => {
	// 当前占用 100 / 128000 ≈ 0.078%，round 后为 0%
	useSessionStore.setState({
		lastUsageBySession: {
			s1: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
		tokenTotals: {
			s1: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, total: 100 },
		},
		contextUsageBySession: { s1: { used: 100, total: 128000, ratio: 0.00078 } },
	});
	useProjectsStore.setState({
		sessions: [
			{
				id: "s1",
				projectId: "p1",
				primaryAgent: "dev",
				title: "测试",
				createdAt: 0,
				lastActivity: 0,
				piSessionFile: "/tmp/s1.jsonl",
			},
		],
		projects: [{ id: "p1", name: "test", cwd: "/work/wa-pi", createdAt: 0 }],
	});

	render(<SessionView sessionId="s1" />);

	expect(screen.getByTestId("token-capsules")).toBeTruthy();
	// 进度条存在且宽度 > 0（有最小可见宽度兜底）
	const progress = screen.getByTestId("token-progress");
	const fill = progress.querySelector(".token-progress-fill") as HTMLElement;
	expect(parseFloat(fill.style.width)).toBeGreaterThan(0);
});

test("token 胶囊：有 contextUsage 时进度条与「占用」用官方口径（与累计分离）", () => {
	// 占用/累计完全由 stats 驱动：占用 64K / 窗口 128K，累计独立为 90K
	useSessionStore.setState({
		lastUsageBySession: {
			s1: { input: 3200, output: 1100, cacheRead: 0, cacheWrite: 0 },
		},
		// 累计 = 90K（含缓存、含压缩前历史），与窗口占用无关
		tokenTotals: {
			s1: {
				input: 20000,
				output: 8000,
				cacheRead: 60000,
				cacheWrite: 2000,
				total: 90000,
			},
		},
		contextUsageBySession: { s1: { used: 64000, total: 128000, ratio: 0.5 } },
	});
	useProjectsStore.setState({
		sessions: [
			{
				id: "s1",
				projectId: "p1",
				primaryAgent: "dev",
				title: "测试",
				createdAt: 0,
				lastActivity: 0,
				piSessionFile: "/tmp/s1.jsonl",
			},
		],
		projects: [{ id: "p1", name: "test", cwd: "/work/wa-pi", createdAt: 0 }],
	});

	render(<SessionView sessionId="s1" />);

	// 累计仍显示 total：90K
	expect(screen.getByText(/累计 90K/)).toBeTruthy();
	// 进度条 = 当前窗口占用 64000/128000 = 50%
	const progress = screen.getByTestId("token-progress");
	const fill = progress.querySelector(".token-progress-fill") as HTMLElement;
	expect(fill.style.width).toBe("50%");
	// 占用 = contextUsage.used = 64K
	expect(screen.getByTestId("token-occupied").textContent).toContain("占用 64K");
	// 布局：占用胶囊（加强）在前、累计胶囊（弱化，独立一列）在后
	const occupied = screen.getByTestId("token-occupied");
	const totalEl = screen.getByTestId("token-total");
	expect(totalEl.className).toContain("token-capsule--total");
	expect(
		occupied.compareDocumentPosition(progress) & Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
	expect(
		progress.compareDocumentPosition(totalEl) & Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
});

test("token 胶囊：有子代理消耗时累计拆分主/子显示", () => {
	useSessionStore.setState({
		lastUsageBySession: {
			s1: { input: 3200, output: 1100, cacheRead: 0, cacheWrite: 0 },
		},
		// 合计 90K = 主 60K + 子 30K
		tokenTotals: {
			s1: {
				input: 20000,
				output: 8000,
				cacheRead: 60000,
				cacheWrite: 2000,
				total: 90000,
				main: 60000,
				subagent: 30000,
			},
		},
	});
	useProjectsStore.setState({
		sessions: [
			{
				id: "s1",
				projectId: "p1",
				primaryAgent: "dev",
				title: "测试",
				createdAt: 0,
				lastActivity: 0,
				piSessionFile: "/tmp/s1.jsonl",
			},
		],
		projects: [{ id: "p1", name: "test", cwd: "/work/wa-pi", createdAt: 0 }],
	});
	render(<SessionView sessionId="s1" />);
	// 两行显示：第一行累计合计，第二行主/子拆分
	expect(screen.getByText(/累计 90K/)).toBeTruthy();
	expect(screen.getByTestId("token-split").textContent).toContain(
		"主 60K · 子 30K",
	);
});

test("token 胶囊：无子代理消耗时累计不显示拆分", () => {
	useSessionStore.setState({
		lastUsageBySession: {
			s1: { input: 3200, output: 1100, cacheRead: 0, cacheWrite: 0 },
		},
		tokenTotals: {
			s1: {
				input: 20000,
				output: 8000,
				cacheRead: 60000,
				cacheWrite: 2000,
				total: 90000,
				main: 90000,
				subagent: 0,
			},
		},
	});
	useProjectsStore.setState({
		sessions: [
			{
				id: "s1",
				projectId: "p1",
				primaryAgent: "dev",
				title: "测试",
				createdAt: 0,
				lastActivity: 0,
				piSessionFile: "/tmp/s1.jsonl",
			},
		],
		projects: [{ id: "p1", name: "test", cwd: "/work/wa-pi", createdAt: 0 }],
	});
	render(<SessionView sessionId="s1" />);
	expect(screen.getByText(/累计 90K/)).toBeTruthy();
	expect(screen.queryByText(/主 90K/)).toBeNull();
});

test("token 胶囊：无 usage 时不显示", () => {
	useSessionStore.setState({
		lastUsageBySession: {},
		tokenTotals: {},
	});
	useProjectsStore.setState({
		sessions: [
			{
				id: "s1",
				projectId: "p1",
				primaryAgent: "dev",
				title: "测试",
				createdAt: 0,
				lastActivity: 0,
				piSessionFile: "/tmp/s1.jsonl",
			},
		],
		projects: [{ id: "p1", name: "test", cwd: "/work/wa-pi", createdAt: 0 }],
	});
	render(<SessionView sessionId="s1" />);
	expect(screen.queryByTestId("token-capsules")).toBeNull();
});

test("扩展 setStatus：聊天列底部状态栏（右对齐），清空后消失", async () => {
	useSessionStore.setState({
		extStatusBySession: { s1: { "pi-lens": "分析中 (3/5 文件)" } },
	});
	await renderSessionView("s1");
	const bar = screen.getByTestId("ext-status-bar");
	expect(bar.textContent).toContain("分析中 (3/5 文件)");
	// 右对齐（只占中间聊天列，不跨侧栏/文件树）
	expect(bar.className).toContain("justify-end");

	act(() => {
		useSessionStore.setState({ extStatusBySession: {} });
	});
	expect(screen.queryByTestId("ext-status-bar")).toBeNull();
});

test("扩展 setWidget：aboveEditor 在 Composer 上方、belowEditor 在下方渲染", async () => {
	useSessionStore.setState({
		extWidgetBySession: {
			s1: {
				"pi-goal": {
					lines: ["── 目标 ──", "进度 4/6"],
					placement: "aboveEditor" as const,
				},
				"pi-lens": {
					lines: ["上次分析：3 个文件"],
					placement: "belowEditor" as const,
				},
			},
		},
	});
	await renderSessionView("s1");
	// 默认收起（悬浮窄条）：显示 key + 首行预览，多行内容（第二行）不可见
	const goal = screen.getByTestId("ext-widget-pi-goal");
	expect(goal.textContent).toContain("pi-goal");
	expect(goal.textContent).toContain("── 目标 ──");
	expect(goal.textContent).not.toContain("进度 4/6");
	// 单行 widget 收起时预览即全文
	expect(screen.getByTestId("ext-widget-pi-lens").textContent).toContain(
		"上次分析：3 个文件",
	);

	// 点击窄条展开后：testid 转移到展开块，可见全部内容
	fireEvent.click(goal);
	const goalExpanded = screen.getByTestId("ext-widget-pi-goal");
	expect(goalExpanded.textContent).toContain("进度 4/6");

	// 点击"收起 ✕"回到窄条，完整内容消失
	fireEvent.click(screen.getByTestId("ext-widget-collapse-pi-goal"));
	const goalChip = screen.getByTestId("ext-widget-pi-goal");
	expect(goalChip.textContent).not.toContain("进度 4/6");
});

test("setStatus/setWidget 的 ANSI 颜色解析为内联样式", async () => {
	useSessionStore.setState({
		extStatusBySession: { s1: { "pi-lens": "\x1b[31m错误 3 个\x1b[39m" } },
		extWidgetBySession: {
			s1: {
				"pi-goal": {
					lines: ["\x1b[32m进度 4/6\x1b[39m", "第二行"],
					placement: "aboveEditor" as const,
				},
			},
		},
	});
	await renderSessionView("s1");

	// setStatus：颜色段为带内联样式的 span，ANSI 码不外泄
	const statusColored = screen.getByText("错误 3 个");
	expect(statusColored.style.color).toBe("#dc2626");
	expect(screen.getByTestId("ext-status-bar").textContent).not.toContain("\x1b");

	// setWidget 收起摘要：首行颜色解析
	const widget = screen.getByTestId("ext-widget-pi-goal");
	const summaryColored = screen.getByText("进度 4/6");
	expect(summaryColored.style.color).toBe("#34a853");

	// setWidget 展开正文：颜色仍解析，纯文本行保留
	fireEvent.click(widget);
	const bodyColored = screen.getByText("进度 4/6");
	expect(bodyColored.style.color).toBe("#34a853");
	const widgetExpanded = screen.getByTestId("ext-widget-pi-goal");
	expect(widgetExpanded.textContent).toContain("第二行");
	expect(widgetExpanded.textContent).not.toContain("\x1b");
});
