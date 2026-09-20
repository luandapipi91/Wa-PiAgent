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
import { useUiPrefsStore } from "../src/store/ui-prefs";

beforeEach(() => {
	useSessionStore.setState({ messagesBySession: {}, progressByToolCall: {} });
	useProjectsStore.setState({ sessions: [] });
	useComposerPrefsStore.setState({ bySession: {} });
	useToastStore.setState({ toasts: [] });
	// 本文件基线为「回复过程折叠开关关闭」（展开），聚焦卡片内容/进度渲染；
	// 折叠开关行为由 process-collapse.behavior / collapse 相关测试单独覆盖。
	useUiPrefsStore.setState({ collapseProcessByDefault: false });
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
	render(<FleetCard sessionId="s1" toolCall={fleetCall} result={fleetResult} />);
	const header = screen.getByTestId("fleet-f1-header");
	expect(header.textContent).toContain("并行派发 2 个任务");
	expect(screen.queryByTestId("fleet-f1-body")).toBeNull();
	expect(screen.getByTestId("fleet-f1").getAttribute("data-muted")).toBe("true");
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
	render(<FleetCard sessionId="s1" toolCall={fleetCall} result={fleetResult} />);
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
	render(
		<VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 60 }}>
			<MessageList sessionId="s1" />
		</VirtuosoMockContext.Provider>,
	);
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
	render(
		<VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 60 }}>
			<MessageList sessionId="s1" />
		</VirtuosoMockContext.Provider>,
	);
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
	render(
		<VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 60 }}>
			<MessageList sessionId="s1" />
		</VirtuosoMockContext.Provider>,
	);
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
	render(<FleetCard sessionId="s1" toolCall={fleetCall} result={fleetResult} />);
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
	render(<FleetCard sessionId="s1" toolCall={fleetCall} result={splitResult} />);
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
	render(<FleetCard sessionId="s1" toolCall={fleetCall} result={splitResult} />);
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

test("FleetCard 子任务展开：状态行（agent·状态·秒数）渲染在回复之后（详情底部）", () => {
	setFleetProgress("tc-st-order", {
		代码审查: {
			status: "running",
			output: "审查中",
			tools: [{ id: "t1", name: "Bash", status: "done" }],
			elapsedMs: 5000,
		},
	});
	const { container } = render(
		<FleetCard
			sessionId="s1"
			toolCall={
				{
					type: "toolCall",
					id: "tc-st-order",
					name: "fleet",
					arguments: { tasks: [] },
				} as any
			}
		/>,
	);
	const rows = screen.getAllByRole("button", { name: /展开|▶/ });
	fireEvent.click(rows[0]);
	const html = container.innerHTML;
	const statusPos = html.indexOf("运行中 · 5s");
	const replyPos = html.indexOf("审查中");
	expect(statusPos).toBeGreaterThan(-1); // 状态行存在
	expect(replyPos).toBeGreaterThan(-1); // 回复存在
	// 状态行必须在回复之后 = 详情底部
	expect(statusPos).toBeGreaterThan(replyPos);
});

test("FleetCard 降级聚合显示：统计行（fleet-progress）渲染在聚合回复区之后（卡片底部）", () => {
	setFleetProgress("tc-old-order", {
		代码审查: {
			status: "done",
			output: "ok",
			tools: [{ id: "t1", name: "Bash", status: "done" }],
			elapsedMs: 1000,
		},
	});
	const { container } = render(
		<FleetCard
			sessionId="s1"
			toolCall={
				{
					type: "toolCall",
					id: "tc-old-order",
					name: "fleet",
					arguments: { tasks: [] },
				} as any
			}
			result={
				{
					role: "toolResult",
					toolCallId: "tc-old-order",
					toolName: "fleet",
					content: [{ type: "text", text: "正文【包含】无法切分" }],
					isError: false,
					timestamp: 0,
				} as any
			}
		/>,
	);
	// 降级：聚合回复区可见
	expect(screen.getByTestId("text-block")).toBeTruthy();
	const progress = container.querySelector(
		"[data-testid='fleet-progress-tc-old-order']",
	);
	const textBlock = container.querySelector("[data-testid='text-block']");
	expect(progress).toBeTruthy();
	// 统计行必须在聚合回复区之后 = 卡片底部
	const rel = textBlock!.compareDocumentPosition(progress!);
	expect(rel & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

// ── 运行期任务行完整性：并行派发（如 4 个委托）时「显示不全」回归 ──
// 根因：任务行只在收到该任务的进度帧后才渲染，而子代理首个进度帧要等它产生第一个业务事件
// （工具调用/文本）——并行派发启动阶段会有若干任务行整行消失，等调用完成后由 details
// 统计补齐；修复后运行期渲染全部任务行，无帧的行显示「排队中」。
test("FleetCard 运行期：尚无进度帧的任务行也渲染（显示「排队中」而非整行消失）", () => {
	useSessionStore.setState({
		progressByToolCall: {
			"tc-allrows": {
				"0": {
					agent: "general-purpose",
					taskIndex: 0,
					status: "running",
					output: "",
					elapsedMs: 1000,
					tools: [{ id: "t1", name: "read", status: "done" }],
				},
				"1": {
					agent: "general-purpose",
					taskIndex: 1,
					status: "running",
					output: "",
					elapsedMs: 900,
					tools: [],
				},
			},
		},
	});
	const call = {
		type: "toolCall" as const,
		id: "tc-allrows",
		name: "fleet",
		arguments: {
			tasks: [
				{ agent: "general-purpose", task: "甲" },
				{ agent: "general-purpose", task: "乙" },
				{ agent: "Explore", task: "丙" },
				{ agent: "Plan", task: "丁" },
			],
		},
	};
	render(<FleetCard sessionId="s1" toolCall={call} />);
	// 4 行全渲染：有帧的行显示工具统计，无帧的行显示「排队中」
	expect(
		screen.getByText(/任务 1：调用了 1 个工具 成功 1 失败 0 执行中 0/),
	).toBeTruthy();
	expect(
		screen.getByText(/任务 2：调用了 0 个工具 成功 0 失败 0 执行中 0/),
	).toBeTruthy();
	expect(screen.getByText(/任务 3：排队中/)).toBeTruthy();
	expect(screen.getByText(/任务 4：排队中/)).toBeTruthy();
	// 无帧的行没有任何可展开内容：不显示展开箭头（无 aria-label）
	const body = screen.getByTestId("fleet-tc-allrows-body");
	const row3 = Array.from(body.querySelectorAll("button")).find((b) =>
		b.textContent?.includes("任务 3"),
	);
	expect(row3).toBeTruthy();
	expect(row3!.getAttribute("aria-label")).toBeNull();
});

test("FleetCard 完成态：仍只渲染有统计/回复的任务行（不靠空行撑开卡片）", () => {
	const doneResult = {
		role: "toolResult" as const,
		toolCallId: "tc-done-rows",
		toolName: "fleet",
		content: [{ type: "text" as const, text: "并行任务结束" }],
		isError: false,
		timestamp: 0,
		details: {
			fleet: {
				"0": { total: 1, done: 1, error: 0, running: 0 },
				// "1" 缺失（老数据/异常）：该行无统计也无回复 → 不渲染
			},
		},
	};
	const call = {
		type: "toolCall" as const,
		id: "tc-done-rows",
		name: "fleet",
		arguments: {
			tasks: [
				{ agent: "general-purpose", task: "甲" },
				{ agent: "Explore", task: "乙" },
			],
		},
	};
	render(<FleetCard sessionId="s1" toolCall={call} result={doneResult} />);
	fireEvent.click(screen.getByTestId("fleet-tc-done-rows-header"));
	expect(
		screen.getByText(/任务 1：已完成 调用了 1 个工具 成功 1 失败 0 执行中 0/),
	).toBeTruthy();
	expect(screen.queryByText(/任务 2：已完成/)).toBeNull();
});

// ── fleet 单任务拒绝结果（kernel 前置校验新增）的消费形态 ──
// 形状：isError=true、content 仅一段引导文案、details={error:"fleet_requires_multiple_tasks"}、
// tasks 只含 1 个 agent。FleetCard 按运行时可选方式读 details（fleetDetails?.fleet / ?.interrupted），
// 本组用例把「不崩 + 渲染引导文案 + 失败态可见 + 不冒出空行/伪造任务行」钉成回归。

const singleTaskRejectCall = {
	type: "toolCall" as const,
	id: "f-single",
	name: "fleet",
	arguments: { tasks: [{ agent: "代码审查", task: "评审改动" }] },
};
const SINGLE_TASK_REJECT_TEXT =
	'错误：fleet 用于并行委派，至少需要 2 个任务（当前只有 1 个）。只委派单个任务时请改用 delegate 单任务工具，例如 delegate(agent="代码审查", task="评审改动")。';

/** 单任务拒绝结果：isError 可切换——true 是「结果标记被透传」的形态；
 *  false 是当前真实链路形态（pi SDK 成功路径恒 isError:false，不读 execute 返回的
 *  result.isError，见 delegate-tool.ts 头注释）。 */
function singleTaskRejectResult(isError: boolean) {
	return {
		role: "toolResult" as const,
		toolCallId: "f-single",
		toolName: "fleet",
		content: [{ type: "text" as const, text: SINGLE_TASK_REJECT_TEXT }],
		isError,
		details: { error: "fleet_requires_multiple_tasks" },
		timestamp: 0,
	};
}

test("FleetCard 单任务拒绝结果（isError=true）：不抛错、渲染引导文案、显示失败态、无任务行/空回复块", () => {
	expect(() =>
		render(
			<FleetCard
				sessionId="s1"
				toolCall={singleTaskRejectCall}
				result={singleTaskRejectResult(true)}
			/>,
		),
	).not.toThrow();

	// 头部：按 tasks 数量渲染标题（1 个），走失败态分支（失败而非完成）
	const header = screen.getByTestId("fleet-f-single-header");
	expect(header.textContent).toContain("并行派发 1 个任务");
	expect(header.textContent).toContain("失败");
	expect(header.textContent).not.toContain("完成");

	// 完成态默认折叠 → 展开看卡片体
	fireEvent.click(header);
	const body = screen.getByTestId("fleet-f-single-body");
	// 引导文案渲染出来（拆不出逐任务回复 → 走降级聚合区）
	expect(body.textContent).toContain("至少需要 2 个任务");
	expect(body.textContent).toContain("delegate");
	// 参数回显的任务清单行仍在（这是真实 params，不是伪造任务）
	expect(body.textContent).toContain("委派【代码审查】评审改动");
	// 拒绝路径无任何子任务统计/回复：不渲染任务统计行容器（不靠空行撑开卡片）
	expect(screen.queryByTestId("fleet-progress-f-single")).toBeNull();
	// 「回复：」只有聚合区 1 处，没有多出来的空回复块
	expect(screen.getAllByText("回复：")).toHaveLength(1);
});

test("FleetCard 单任务拒绝结果（isError=false，当前真实链路形态）：引导文案照常渲染、无任务行；不出现失败态（现状锁）", () => {
	// pi SDK 不把 execute 返回的 result.isError 透传到 ToolResultMessage（成功路径恒
	// isError:false），因此真实会话里该结果的 isError 是 false。本用例锁住这一现状——
	// 将来 SDK/宿主补上透传后，「不出现失败态」的断言需同步改期望。
	expect(() =>
		render(
			<FleetCard
				sessionId="s1"
				toolCall={singleTaskRejectCall}
				result={singleTaskRejectResult(false)}
			/>,
		),
	).not.toThrow();

	const header = screen.getByTestId("fleet-f-single-header");
	expect(header.textContent).not.toContain("失败");
	fireEvent.click(header);
	const body = screen.getByTestId("fleet-f-single-body");
	expect(body.textContent).toContain("至少需要 2 个任务");
	expect(screen.queryByTestId("fleet-progress-f-single")).toBeNull();
	expect(screen.getAllByText("回复：")).toHaveLength(1);
});

// ── fleet 超并发上限拒绝结果的消费形态 ──

const tooManyRejectCall = {
	type: "toolCall" as const,
	id: "f-toomany",
	name: "fleet",
	arguments: {
		tasks: Array.from({ length: 7 }, (_, i) => ({
			agent: "质量验收",
			task: `task${i}`,
		})),
	},
};
const TOO_MANY_REJECT_TEXT =
	"错误：fleet 一次最多 6 个任务（当前 7 个）。请拆成多次 fleet 调用（每次不超过 6 个）。";

test("FleetCard 超上限拒绝结果：不抛错、渲染引导文案、7 条参数回显行、无统计行/空回复块", () => {
	expect(() =>
		render(
			<FleetCard
				sessionId="s1"
				toolCall={tooManyRejectCall}
				result={{
					role: "toolResult" as const,
					toolCallId: "f-toomany",
					toolName: "fleet",
					content: [{ type: "text" as const, text: TOO_MANY_REJECT_TEXT }],
					isError: true,
					details: { error: "fleet_too_many_tasks" },
					timestamp: 0,
				}}
			/>,
		),
	).not.toThrow();

	// 头部：按参数里的 7 条任务渲染标题，走失败态分支
	const header = screen.getByTestId("fleet-f-toomany-header");
	expect(header.textContent).toContain("并行派发 7 个任务");
	expect(header.textContent).toContain("失败");
	fireEvent.click(header);
	const body = screen.getByTestId("fleet-f-toomany-body");
	// 引导文案渲染出来（拆不出逐任务回复 → 走降级聚合区）
	expect(body.textContent).toContain("最多 6 个");
	expect(body.textContent).toContain("拆成多次");
	expect(body.textContent).not.toContain("delegate");
	// 参数回显的 7 条任务清单都在（真实 params，不是伪造任务）
	expect(body.textContent).toContain("委派【质量验收】task0");
	expect(body.textContent).toContain("委派【质量验收】task6");
	// 拒绝路径无任何子任务统计：不渲染任务统计行容器
	expect(screen.queryByTestId("fleet-progress-f-toomany")).toBeNull();
	// 「回复：」只有聚合区 1 处
	expect(screen.getAllByText("回复：")).toHaveLength(1);
});
