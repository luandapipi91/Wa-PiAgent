import { test, expect, describe, beforeEach } from "bun:test";
import { render, screen, act } from "@testing-library/react";
import { ToolCallCard } from "../src/components/blocks/ToolCallCard";
import { ThinkingCard } from "../src/components/blocks/ThinkingCard";
import { DelegateCard } from "../src/components/blocks/DelegateCard";
import { FleetCard } from "../src/components/blocks/FleetCard";
import { useUiPrefsStore } from "../src/store/ui-prefs";
import { COLLAPSE_PROCESS_DEFAULT } from "../src/store/ui-prefs";
import { useSessionStore } from "../src/store/session";

const call = {
	type: "toolCall" as const,
	id: "c1",
	name: "read",
	arguments: { path: "/a" },
};

const delegateCall = {
	type: "toolCall" as const,
	id: "d1",
	name: "delegate",
	arguments: { agent: "代码审查", task: "review diff" },
};

const fleetCall = {
	type: "toolCall" as const,
	id: "f1",
	name: "fleet",
	arguments: { tasks: [{ agent: "代码审查", task: "review" }] },
};

beforeEach(() => {
	localStorage.clear();
	useUiPrefsStore.setState({
		collapseProcessByDefault: COLLAPSE_PROCESS_DEFAULT,
	});
	useSessionStore.setState({ messagesBySession: {}, progressByToolCall: {} });
});

describe("回复过程默认折叠开关（开启 = 工具调用/思维链默认不展开）", () => {
	test("开关开启：流式中工具调用默认折叠（body 不渲染，header 可见，可点击）", () => {
		render(<ToolCallCard toolCall={call} isStreaming />);
		// 卡片头可见，可直接点击展开
		expect(screen.getByTestId("toolcall-c1-header")).toBeTruthy();
		// body 默认不渲染（折叠）
		expect(screen.queryByTestId("toolcall-c1-body")).toBeNull();
	});

	test("开关开启：思维链（流式中）默认折叠", () => {
		render(<ThinkingCard thinking="我在想" isStreaming />);
		expect(screen.getByTestId("thinking-panel-header")).toBeTruthy();
		expect(screen.queryByTestId("thinking-panel-body")).toBeNull();
	});

	test("开关关闭（展开基线）：流式中工具调用默认展开（回归防护）", () => {
		useUiPrefsStore.setState({ collapseProcessByDefault: false });
		render(<ToolCallCard toolCall={call} isStreaming />);
		expect(screen.getByTestId("toolcall-c1-body")).toBeTruthy();
	});

	test("开关关闭（展开基线）：流式中思维链默认展开（回归防护）", () => {
		useUiPrefsStore.setState({ collapseProcessByDefault: false });
		render(<ThinkingCard thinking="我在想" isStreaming />);
		expect(screen.getByTestId("thinking-panel-body")).toBeTruthy();
	});

	test("开关开启：delegate 委派卡片（有实时进度）默认折叠（body 不渲染）", () => {
		render(<DelegateCard sessionId="s1" toolCall={delegateCall} isStreaming />);
		// 注入进度，触发 hasProgress=true（旧逻辑此处默认展开）
		act(() => {
			useSessionStore.getState().handleSubagentProgress("s1", "d1", {
				agent: "代码审查",
				status: "running",
				output: "正在审查…",
				tools: [],
				elapsedMs: 100,
			} as any);
		});
		// header 可见，body 默认不渲染（折叠）
		expect(screen.getByTestId("delegate-d1-header")).toBeTruthy();
		expect(screen.queryByTestId("delegate-d1-body")).toBeNull();
	});

	test("开关开启：fleet 并行派发卡片（有实时进度）默认折叠（body 不渲染）", () => {
		render(<FleetCard sessionId="s1" toolCall={fleetCall} isStreaming />);
		act(() => {
			useSessionStore.getState().handleSubagentProgress("s1", "f1", {
				agent: "代码审查",
				status: "running",
				output: "并行…",
				tools: ["read"],
				elapsedMs: 100,
			} as any);
		});
		expect(screen.getByTestId("fleet-f1-header")).toBeTruthy();
		expect(screen.queryByTestId("fleet-f1-body")).toBeNull();
	});

	test("开关关闭（展开基线）：delegate 有进度时默认展开（回归防护）", () => {
		useUiPrefsStore.setState({ collapseProcessByDefault: false });
		render(<DelegateCard sessionId="s1" toolCall={delegateCall} isStreaming />);
		act(() => {
			useSessionStore.getState().handleSubagentProgress("s1", "d1", {
				agent: "代码审查",
				status: "running",
				output: "正在审查…",
				tools: [],
				elapsedMs: 100,
			} as any);
		});
		expect(screen.getByTestId("delegate-d1-body")).toBeTruthy();
	});

	test("开关关闭（展开基线）：fleet 有进度时默认展开（回归防护）", () => {
		useUiPrefsStore.setState({ collapseProcessByDefault: false });
		render(<FleetCard sessionId="s1" toolCall={fleetCall} isStreaming />);
		act(() => {
			useSessionStore.getState().handleSubagentProgress("s1", "f1", {
				agent: "代码审查",
				status: "running",
				output: "并行…",
				tools: ["read"],
				elapsedMs: 100,
			} as any);
		});
		expect(screen.getByTestId("fleet-f1-body")).toBeTruthy();
	});
});
