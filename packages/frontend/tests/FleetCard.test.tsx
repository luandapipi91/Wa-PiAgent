import { test, expect, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import type { SessionMessage } from "@hiagent/shared";
import { FleetCard } from "../src/components/blocks/FleetCard";
import { MessageList } from "../src/components/MessageList";
import { useSessionStore } from "../src/store/session";
import { useProjectsStore } from "../src/store/projects";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { useToastStore } from "../src/store/toast";

beforeEach(() => {
	useSessionStore.setState({ messagesBySession: {} });
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

test("FleetCard 完成（非流式）：默认折叠，头部显示「并行派发 N 个任务」", () => {
	render(
		<FleetCard sessionId="s1" toolCall={fleetCall} result={fleetResult} />,
	);
	const header = screen.getByTestId("fleet-f1-header");
	expect(header.textContent).toContain("并行派发 2 个任务");
	expect(screen.queryByTestId("fleet-f1-body")).toBeNull();
});

test("FleetCard 流式中（isStreaming + 无 result）：默认展开且 meta 含「执行中」", () => {
	render(<FleetCard sessionId="s1" toolCall={fleetCall} isStreaming />);
	expect(screen.getByTestId("fleet-f1-body")).toBeTruthy();
	const header = screen.getByTestId("fleet-f1-header");
	expect(header.textContent).toContain("执行中");
	// 展开后各子任务可见
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
