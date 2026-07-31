import { test, expect, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import type { SessionMessage } from "@wa-pi/shared";
import { FleetCard } from "../src/components/blocks/FleetCard";
import { MessageList } from "../src/components/MessageList";
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

test("FleetCard 失败（result.isError）：meta 含「✗ 失败」", () => {
	const errResult = {
		...fleetResult,
		isError: true,
		content: [{ type: "text" as const, text: "并行任务部分失败" }],
	};
	render(<FleetCard sessionId="s1" toolCall={fleetCall} result={errResult} />);
	const header = screen.getByTestId("fleet-f1-header");
	expect(header.textContent).toContain("✗ 失败");
	expect(header.textContent).not.toContain("✓ 完成");
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
	render(<MessageList sessionId="s1" />);
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
	render(<MessageList sessionId="s1" />);
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
	render(<MessageList sessionId="s1" />);
	expect(screen.getByTestId("fleet-f1")).toBeTruthy();
	expect(screen.getByTestId("delegate-d1")).toBeTruthy();
});

// ── Task 10：按 agent 分组展示多个子代理进度（默认折叠摘要，展开看每 agent 详情）──
// fleet 与 delegate 的关键差异：fleet 一个 toolCallId 下多个 agent，
// store 的 progressByToolCall[tcId] 是 Record<agent, SubagentProgressEvent>，
// FleetCard 直接消费整个 map（不取 [0]），按 agent 分组展示。

/** 设置某 toolCallId 下的多个子代理进度（fleet 多 agent 场景） */
function setFleetProgress(toolCallId: string, agents: Record<string, { status?: string; output?: string; tools?: any[]; elapsedMs?: number }>) {
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

test("FleetCard 按 agent 分组展示进度摘要：N 个子智能体：X 运行中 / Y 完成 / Z 出错", () => {
	setFleetProgress("tc-fleet", {
		"agent-a": { status: "running", output: "a", tools: [], elapsedMs: 1000 },
		"agent-b": { status: "done", output: "b", tools: [], elapsedMs: 2000 },
		"agent-c": { status: "error", output: "c", tools: [], elapsedMs: 3000 },
	});
	render(
		<FleetCard
			sessionId="s1"
			toolCall={{ type: "toolCall", id: "tc-fleet", name: "fleet", arguments: { tasks: [] } } as any}
		/>,
	);
	// 摘要：3 个子智能体：1 运行中 / 1 完成 / 1 出错
	expect(screen.getByText(/1\s*运行中/)).toBeTruthy();
	expect(screen.getByText(/1\s*完成/)).toBeTruthy();
	expect(screen.getByText(/1\s*出错/)).toBeTruthy();
	expect(screen.getByText(/3\s*个子智能体/)).toBeTruthy();
});

test("FleetCard 有进度时默认折叠摘要开关可见，output 不可见；展开后见各 agent 分组详情", () => {
	setFleetProgress("tc-exp", {
		"代码审查": {
			status: "running",
			output: "审查中",
			tools: [{ id: "t1", name: "Bash", status: "done" }],
			elapsedMs: 5000,
		},
		"前端开发": {
			status: "done",
			output: "样式完成",
			tools: [{ id: "t2", name: "Edit", status: "done" }],
			elapsedMs: 8000,
		},
	});
	render(
		<FleetCard
			sessionId="s1"
			toolCall={{ type: "toolCall", id: "tc-exp", name: "fleet", arguments: { tasks: [] } } as any}
		/>,
	);
	// 摘要开关存在且为折叠态（▶）
	const toggle = screen.getByRole("button", { name: /展开|▶/ });
	expect(toggle).toBeTruthy();
	// 折叠态：各 agent 的 output 默认不可见
	expect(screen.queryByText("审查中")).toBeNull();
	expect(screen.queryByText("样式完成")).toBeNull();
	// 展开进度详情
	fireEvent.click(toggle);
	expect(screen.getByText("审查中")).toBeTruthy();
	expect(screen.getByText("样式完成")).toBeTruthy();
	// 各 agent 名称可见（分组标题）
	expect(screen.getByText(/代码审查/)).toBeTruthy();
	expect(screen.getByText(/前端开发/)).toBeTruthy();
	// 工具时间线可见
	expect(screen.getByText(/Bash/)).toBeTruthy();
	expect(screen.getByText(/Edit/)).toBeTruthy();
});

test("FleetCard 无进度时不渲染子智能体摘要（保持原有行为）", () => {
	useSessionStore.setState({ progressByToolCall: {} });
	render(
		<FleetCard
			sessionId="s1"
			toolCall={{ type: "toolCall", id: "tc-none", name: "fleet", arguments: { tasks: [] } } as any}
		/>,
	);
	expect(screen.queryByText(/个子智能体/)).toBeNull();
	expect(screen.queryByRole("button", { name: /展开|▶/ })).toBeNull();
});
