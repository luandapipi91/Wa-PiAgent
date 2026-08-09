import { test, expect, beforeEach, vi } from "bun:test";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { SessionMessage } from "@wa-pi/shared";
import { FleetCard } from "../src/components/blocks/FleetCard";
import { MessageList } from "../src/components/MessageList";
import { VirtuosoMockContext } from "react-virtuoso";
import { useSessionStore } from "../src/store/session";
import { useProjectsStore } from "../src/store/projects";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { useToastStore } from "../src/store/toast";

beforeEach(() => {
	useSessionStore.setState({ messagesBySession: {}, progressByToolCall: {} });
	useProjectsStore.setState({ sessions: [] });
	useComposerPrefsStore.setState({ bySession: {} });
	useToastStore.setState({ toasts: [] });
});

const fleetCall = {
	type: "toolCall" as const,
	id: "f1",
	name: "fleet",
	arguments: {
		tasks: [
			{ agent: "代码审查", task: "review diff" },
			{ agent: "前端开发", task: "重构 UI" },
		],
	},
};

const fleetResult = {
	role: "toolResult" as const,
	toolCallId: "f1",
	toolName: "fleet",
	content: [
		{ type: "text" as const, text: "并行任务完成：review 通过，UI 已重构" },
	],
	isError: false,
	timestamp: 0,
};

function assistantMsg(
	timestamp: number,
	content: any[],
	agentName: SessionMessage["agentName"] = "product",
): SessionMessage {
	return {
		agentName,
		message: {
			role: "assistant",
			content,
			model: "pi-test",
			stopReason: "end_turn",
			timestamp,
		},
	};
}

test("FleetCard 完成（非流式）：默认折叠，头部显示「并行派发 N 个任务」，且 data-muted=true", () => {
	render(
		<FleetCard sessionId="s1" toolCall={fleetCall} result={fleetResult} />,
	);
	const header = screen.getByTestId("fleet-f1-header");
	expect(header.textContent).toContain("并行派发 2 个任务");
	expect(screen.queryByTestId("fleet-f1-body")).toBeNull();
	expect(screen.getByTestId("fleet-f1").getAttribute("data-muted")).toBe(
		"true",
	);
});

test("FleetCard 执行中（无 result、非流式，如 block 已定稿但工具未返回）：默认展开且不透明", () => {
	render(<FleetCard sessionId="s1" toolCall={fleetCall} />);
	// 并行派发还在执行中，卡片应展开（body 可见）且不弱化
	expect(screen.getByTestId("fleet-f1-body")).toBeTruthy();
	expect(screen.getByTestId("fleet-f1").getAttribute("data-muted")).toBeNull();
});

test("FleetCard 流式中（isStreaming + 无 result）：默认展开、不透明、meta 含「执行中」", () => {
	render(<FleetCard sessionId="s1" toolCall={fleetCall} isStreaming />);
	expect(screen.getByTestId("fleet-f1-body")).toBeTruthy();
	expect(screen.getByTestId("fleet-f1").getAttribute("data-muted")).toBeNull();
	const header = screen.getByTestId("fleet-f1-header");
	expect(header.textContent).toContain("执行中");
	const body = screen.getByTestId("fleet-f1-body");
	expect(body.textContent).toContain("代码审查");
	expect(body.textContent).toContain("review diff");
	expect(body.textContent).toContain("前端开发");
	expect(body.textContent).toContain("重构 UI");
});

test("FleetCard 失败（result.isError）：meta 含「失败」", () => {
	const errResult = {
		...fleetResult,
		isError: true,
		content: [{ type: "text" as const, text: "并行任务部分失败" }],
	};
	render(<FleetCard sessionId="s1" toolCall={fleetCall} result={errResult} />);
	const header = screen.getByTestId("fleet-f1-header");
	expect(header.textContent).toContain("失败");
	expect(header.textContent).not.toContain("完成");
});

test("FleetCard 展开后结果经 ReactMarkdown 渲染", () => {
	render(
		<FleetCard sessionId="s1" toolCall={fleetCall} result={fleetResult} />,
	);
	fireEvent.click(screen.getByTestId("fleet-f1-header"));
	const body = screen.getByTestId("fleet-f1-body");
	expect(body.textContent).toContain("并行任务完成");
});

test("MessageList 中 fleet 工具调用渲染为 FleetCard（非 ToolCallCard）", () => {
	useSessionStore.setState({
		messagesBySession: {
			s1: [
				assistantMsg(1, [
					{
						type: "toolCall",
						id: "f1",
						name: "fleet",
						arguments: { tasks: [{ agent: "代码审查", task: "review diff" }] },
					},
				]),
				{
					agentName: "product",
					message: {
						role: "toolResult",
						toolCallId: "f1",
						toolName: "fleet",
						content: [{ type: "text", text: "完成" }],
						isError: false,
						timestamp: 2,
					},
				},
			],
		},
	});
	render(<VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 60 }}><MessageList sessionId="s1" /></VirtuosoMockContext.Provider>);
	// 轮级折叠：已定稿行过程段默认折叠进摘要行，先展开再断言卡片
	fireEvent.click(screen.getByTestId("turn-summary"));
	// fleet 卡片直接可见（内联在消息流中）
	expect(screen.getByTestId("fleet-f1")).toBeTruthy();
	// 不应出现普通工具调用卡片
	expect(screen.queryByTestId("toolcall-f1")).toBeNull();
});

test("fleet 与普通 toolCall 混合：fleet 独立成卡，普通调用为独立工具卡", () => {
	useSessionStore.setState({
		messagesBySession: {
			s1: [
				assistantMsg(1, [
					{
						type: "toolCall",
						id: "f1",
						name: "fleet",
						arguments: { tasks: [{ agent: "代码审查", task: "review diff" }] },
					},
					{
						type: "toolCall",
						id: "c1",
						name: "read",
						arguments: { path: "/a" },
					},
				]),
				{
					agentName: "product",
					message: {
						role: "toolResult",
						toolCallId: "f1",
						toolName: "fleet",
						content: [{ type: "text", text: "完成" }],
						isError: false,
						timestamp: 2,
					},
				},
			],
		},
	});
	render(<VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 60 }}><MessageList sessionId="s1" /></VirtuosoMockContext.Provider>);
	// 轮级折叠：已定稿行过程段默认折叠进摘要行，先展开再断言卡片
	fireEvent.click(screen.getByTestId("turn-summary"));
	// fleet 卡片直接可见
	expect(screen.getByTestId("fleet-f1")).toBeTruthy();
	// 单个普通调用 → 独立单卡
	expect(screen.getByTestId("toolcall-c1")).toBeTruthy();
	// fleet 不嵌在工具卡内
	expect(
		screen.getByTestId("toolcall-c1").querySelector("[data-testid='fleet-f1']"),
	).toBeNull();
	expect(screen.getAllByTestId("fleet-f1")).toHaveLength(1);
});

test("fleet 与 delegate 混合：各自独立成卡，互不干扰", () => {
	useSessionStore.setState({
		messagesBySession: {
			s1: [
				assistantMsg(1, [
					{
						type: "toolCall",
						id: "f1",
						name: "fleet",
						arguments: { tasks: [{ agent: "前端开发", task: "写样式" }] },
					},
					{
						type: "toolCall",
						id: "d1",
						name: "delegate",
						arguments: { agent: "代码审查", task: "review diff" },
					},
				]),
				{
					agentName: "product",
					message: {
						role: "toolResult",
						toolCallId: "f1",
						toolName: "fleet",
						content: [{ type: "text", text: "完成" }],
						isError: false,
						timestamp: 2,
					},
				},
				{
					agentName: "product",
					message: {
						role: "toolResult",
						toolCallId: "d1",
						toolName: "delegate",
						content: [{ type: "text", text: "发现 2 个问题…" }],
						isError: false,
						timestamp: 3,
					},
				},
			],
		},
	});
	render(<VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 60 }}><MessageList sessionId="s1" /></VirtuosoMockContext.Provider>);
	// 轮级折叠：已定稿行过程段默认折叠进摘要行，先展开再断言卡片
	fireEvent.click(screen.getByTestId("turn-summary"));
	expect(screen.getByTestId("fleet-f1")).toBeTruthy();
	expect(screen.getByTestId("delegate-d1")).toBeTruthy();
});

// ── Task 10：按 agent 分组展示多个子代理进度（默认折叠摘要，展开看每 agent 详情）──
// fleet 与 delegate 的关键差异：fleet 一个 toolCallId 下多个 agent，
// store 的 progressByToolCall[tcId] 是 Record<agent, SubagentProgressEvent>，
// FleetCard 直接消费整个 map（不取 [0]），按 agent 分组展示。

/** 设置某 toolCallId 下的多个子代理进度（fleet 多 agent 场景） */
function setFleetProgress(
	toolCallId: string,
	agents: Record<
		string,
		{ status?: string; output?: string; tools?: any[]; elapsedMs?: number }
	>,
) {
	const map: Record<string, any> = {};
	for (const [agent, p] of Object.entries(agents)) {
		map[agent] = {
			agent,
			status: p.status ?? "running",
			output: p.output ?? "",
			tools: p.tools ?? [],
			elapsedMs: p.elapsedMs ?? 0,
		};
	}
	useSessionStore.setState({ progressByToolCall: { [toolCallId]: map } });
}

test("FleetCard 按 agent 展示进度：每任务一行统计（任务 N：调用了 X 个工具 成功 Y 失败 Z 执行中 W）", () => {
	setFleetProgress("tc-fleet", {
		"agent-a": { status: "running", output: "a", tools: [], elapsedMs: 1000 },
		"agent-b": { status: "done", output: "b", tools: [], elapsedMs: 2000 },
		"agent-c": { status: "error", output: "c", tools: [], elapsedMs: 3000 },
	});
	render(
		<FleetCard
			sessionId="s1"
			toolCall={
				{
					type: "toolCall",
					id: "tc-fleet",
					name: "fleet",
					arguments: { tasks: [] },
				} as any
			}
		/>,
	);
	// 每任务统计行：编号 + 工具计数（tasks 为空时按 progress agents 兜底编号）
	expect(
		screen.getByText(/任务 1：调用了 0 个工具 成功 0 失败 0 执行中 0/),
	).toBeTruthy();
	expect(screen.getByText(/任务 2：调用了 0 个工具/)).toBeTruthy();
	expect(screen.getByText(/任务 3：调用了 0 个工具/)).toBeTruthy();
	// 状态（运行中/完成/出错）在展开后可见，不体现在统计行
	expect(screen.queryByText(/运行中/)).toBeNull();
});

test("FleetCard 有进度时：统计行含工具计数，点开任务行显示该任务回复", () => {
	setFleetProgress("tc-exp", {
		代码审查: {
			status: "running",
			output: "审查中",
			tools: [
				{ id: "t1", name: "Bash", status: "done" },
				{ id: "t2", name: "Read", status: "running" },
			],
			elapsedMs: 5000,
		},
		前端开发: {
			status: "done",
			output: "样式完成",
			tools: [{ id: "t3", name: "Edit", status: "done" }],
			elapsedMs: 8000,
		},
	});
	render(
		<FleetCard
			sessionId="s1"
			toolCall={
				{
					type: "toolCall",
					id: "tc-exp",
					name: "fleet",
					arguments: { tasks: [] },
				} as any
			}
		/>,
	);
	// 统计行默认可见，含工具计数（无需展开）
	expect(
		screen.getByText(/任务 1：调用了 2 个工具 成功 1 失败 0 执行中 1/),
	).toBeTruthy();
	expect(
		screen.getByText(/任务 2：调用了 1 个工具 成功 1 失败 0 执行中 0/),
	).toBeTruthy();
	// 未展开时回复不可见
	expect(screen.queryByText(/审查中/)).toBeNull();
	expect(screen.queryByText(/样式完成/)).toBeNull();
	// 点开任务 1 → 只显示该任务回复
	const rows = screen.getAllByRole("button", { name: /展开|▶/ });
	fireEvent.click(rows[0]);
	expect(screen.getByText(/审查中/)).toBeTruthy();
	expect(screen.queryByText(/样式完成/)).toBeNull();
	// 工具只显示计数，不再逐条列出名称
	expect(screen.queryByText(/Bash/)).toBeNull();
	expect(screen.queryByText(/Edit/)).toBeNull();
});

test("FleetCard 任务清单格式：任务 N：委派【agent】task", () => {
	render(
		<FleetCard sessionId="s1" toolCall={fleetCall} result={fleetResult} />,
	);
	fireEvent.click(screen.getByTestId("fleet-f1-header"));
	const body = screen.getByTestId("fleet-f1-body");
	expect(body.textContent).toContain("任务 1：委派【代码审查】review diff");
	expect(body.textContent).toContain("任务 2：委派【前端开发】重构 UI");
});

test("FleetCard 完成态按 agent 拆分：每任务点开显示各自回复（无 progress 时统计行显示已完成）", () => {
	useSessionStore.setState({ progressByToolCall: {} });
	const splitResult = {
		...fleetResult,
		content: [
			{
				type: "text" as const,
				text: "【代码审查】review 通过\n\n【前端开发】UI 已重构",
			},
		],
	};
	render(
		<FleetCard sessionId="s1" toolCall={fleetCall} result={splitResult} />,
	);
	fireEvent.click(screen.getByTestId("fleet-f1-header"));
	// 无 progress：统计行显示「已完成 · 点击查看回复」
	expect(screen.getByText(/任务 1：已完成 · 点击查看回复/)).toBeTruthy();
	expect(screen.getByText(/任务 2：已完成 · 点击查看回复/)).toBeTruthy();
	// 点开任务 1 → 只显示代码审查的回复
	const rows = screen.getAllByRole("button", { name: /展开|▶/ });
	fireEvent.click(rows[0]);
	expect(screen.getByText(/review 通过/)).toBeTruthy();
	expect(screen.queryByText(/UI 已重构/)).toBeNull();
	// 点开任务 2 → 显示前端开发的回复
	const rows2 = screen.getAllByRole("button", { name: /展开|▶/ });
	fireEvent.click(rows2[0]);
	expect(screen.getByText(/UI 已重构/)).toBeTruthy();
});

test("FleetCard 完成态读 result.details 持久化统计：无 progress 也显示工具计数", () => {
	useSessionStore.setState({ progressByToolCall: {} });
	const splitResult = {
		...fleetResult,
		content: [
			{
				type: "text" as const,
				text: "【代码审查】review 通过\n\n【前端开发】UI 已重构",
			},
		],
		details: {
			fleet: {
				代码审查: { total: 3, done: 2, error: 1, running: 0 },
				前端开发: { total: 1, done: 1, error: 0, running: 0 },
			},
		},
	};
	render(
		<FleetCard sessionId="s1" toolCall={fleetCall} result={splitResult} />,
	);
	fireEvent.click(screen.getByTestId("fleet-f1-header"));
	// 无 progress 但有持久化统计：完成态统计行显示「已完成 调用了 X 个工具 …」
	expect(
		screen.getByText(
			/任务 1：已完成 调用了 3 个工具 成功 2 失败 1 执行中 0 · 点击查看回复/,
		),
	).toBeTruthy();
	expect(
		screen.getByText(
			/任务 2：已完成 调用了 1 个工具 成功 1 失败 0 执行中 0 · 点击查看回复/,
		),
	).toBeTruthy();
});

test("FleetCard 无进度时不渲染子智能体摘要（保持原有行为）", () => {
	useSessionStore.setState({ progressByToolCall: {} });
	render(
		<FleetCard
			sessionId="s1"
			toolCall={
				{
					type: "toolCall",
					id: "tc-none",
					name: "fleet",
					arguments: { tasks: [] },
				} as any
			}
		/>,
	);
	expect(screen.queryByText(/个子智能体/)).toBeNull();
	expect(screen.queryByRole("button", { name: /展开|▶/ })).toBeNull();
});

test("FleetCard 运行中子代理在无事件推送期间：本地推算计时持续递增（静默期不冻结）", () => {
	vi.useFakeTimers();
	const nowSpy = vi.spyOn(Date, "now").mockReturnValue(0);
	try {
		setFleetProgress("tc-timer", {
			"agent-a": {
				status: "running",
				output: "思考中",
				tools: [],
				elapsedMs: 1000,
			},
		});
		render(
			<FleetCard
				sessionId="s1"
				toolCall={
					{
						type: "toolCall",
						id: "tc-timer",
						name: "fleet",
						arguments: { tasks: [] },
					} as any
				}
			/>,
		);
		// 点开任务行（耗时在任务展开区内）
		fireEvent.click(screen.getByRole("button", { name: /展开|▶/ }));
		expect(screen.getByText(/1\s*s/)).toBeTruthy();
		// 3 秒静默（思考中，无新进度事件）：时间前进，计时应本地推算到 4s
		act(() => {
			nowSpy.mockReturnValue(3000);
			vi.advanceTimersByTime(3000);
		});
		expect(screen.getByText(/4\s*s/)).toBeTruthy();
		expect(screen.queryByText(/1\s*s/)).toBeNull();
	} finally {
		nowSpy.mockRestore();
		vi.useRealTimers();
	}
});

test("FleetCard 有进度时：头部点击折叠/展开整张卡片（子任务展开不锁死卡片）", () => {
	setFleetProgress("tc-fold", {
		"agent-a": {
			status: "running",
			output: "a",
			tools: [],
			elapsedMs: 1000,
		},
	});
	render(
		<FleetCard
			sessionId="s1"
			toolCall={
				{
					type: "toolCall",
					id: "tc-fold",
					name: "fleet",
					arguments: { tasks: [] },
				} as any
			}
		/>,
	);
	// 有进度时卡片默认展开（任务清单/统计行可见）
	expect(screen.getByTestId("fleet-tc-fold-body")).toBeTruthy();
	// 点头部 → 整张卡片折叠
	fireEvent.click(screen.getByTestId("fleet-tc-fold-header"));
	expect(screen.queryByTestId("fleet-tc-fold-body")).toBeNull();
	// 再点头部 → 重新展开
	fireEvent.click(screen.getByTestId("fleet-tc-fold-header"));
	expect(screen.getByTestId("fleet-tc-fold-body")).toBeTruthy();
});

test("FleetCard 子任务详情展开后可单独收起（不受卡片折叠状态影响）", () => {
	setFleetProgress("tc-item", {
		"agent-a": {
			status: "done",
			output: "回复内容",
			tools: [],
			elapsedMs: 1000,
		},
	});
	render(
		<FleetCard
			sessionId="s1"
			toolCall={
				{
					type: "toolCall",
					id: "tc-item",
					name: "fleet",
					arguments: { tasks: [] },
				} as any
			}
		/>,
	);
	// 点任务行展开详情
	const row = screen.getByRole("button", { name: /展开|▶/ });
	fireEvent.click(row);
	expect(screen.getByText(/回复内容/)).toBeTruthy();
	// 再点任务行收起详情（不被任何 forceExpanded 锁死）
	fireEvent.click(screen.getByRole("button", { name: /折叠|▼/ }));
	expect(screen.queryByText(/回复内容/)).toBeNull();
});

test("FleetCard 执行中 progress 陆续到达不自动重新打开已折叠的卡片", () => {
	// 初始无 progress：执行中卡片默认展开（任务清单可见）
	render(
		<FleetCard
			sessionId="s1"
			toolCall={
				{
					type: "toolCall",
					id: "tc-keepfold",
					name: "fleet",
					arguments: { tasks: [] },
				} as any
			}
		/>,
	);
	expect(screen.getByTestId("fleet-tc-keepfold-body")).toBeTruthy();
	// 用户折叠卡片
	fireEvent.click(screen.getByTestId("fleet-tc-keepfold-header"));
	expect(screen.queryByTestId("fleet-tc-keepfold-body")).toBeNull();
	// progress 事件到达：卡片应保持折叠
	setFleetProgress("tc-keepfold", {
		"agent-a": {
			status: "running",
			output: "a",
			tools: [],
			elapsedMs: 1000,
		},
	});
	expect(screen.queryByTestId("fleet-tc-keepfold-body")).toBeNull();
});
