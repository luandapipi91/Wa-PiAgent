// DelegateCard 多智能体标题契约（2026-11-25 新格式）：
// 多任务时标题为「{首个智能体}等 N 名智能体执行 M 个任务」，修复执行中
// （result 未返回、subagentCount=0）误显示单任务标题的 bug。
import { test, expect, beforeEach } from "bun:test";
import { render, screen } from "@testing-library/react";
import i18next from "i18next";
import { DelegateCard } from "../src/components/blocks/DelegateCard";
import { useSessionStore } from "../src/store/session";
import { useProjectsStore } from "../src/store/projects";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { useToastStore } from "../src/store/toast";
import { useUiPrefsStore } from "../src/store/ui-prefs";

beforeEach(async () => {
	await i18next.changeLanguage("zh");
	useSessionStore.setState({ messagesBySession: {}, progressByToolCall: {} });
	useProjectsStore.setState({ sessions: [] });
	useComposerPrefsStore.setState({ bySession: {} });
	useToastStore.setState({ toasts: [] });
	useUiPrefsStore.setState({ collapseProcessByDefault: false });
});

// 执行中形状：无 result、3 个任务、两个不同 agent（数据分析师×2 + general-purpose×1）
const runningCall = {
	type: "toolCall" as const,
	id: "trun",
	name: "delegate",
	arguments: {
		tasks: [
			{ agent: "数据分析师", task: "分析 A" },
			{ agent: "数据分析师", task: "分析 B" },
			{ agent: "general-purpose", task: "汇总" },
		],
	},
};

// 完成态形状：details.subagents 3 条、含 2 个不同 agent
const doneResult = {
	role: "toolResult" as const,
	toolCallId: "trun",
	toolName: "delegate",
	content: [{ type: "text" as const, text: "全部完成" }],
	isError: false,
	timestamp: 0,
	details: {
		subagents: [
			{ taskIndex: 0, agent: "数据分析师", agentId: "a1", status: "completed", interrupted: false },
			{ taskIndex: 1, agent: "数据分析师", agentId: "a2", status: "completed", interrupted: false },
			{ taskIndex: 2, agent: "general-purpose", agentId: "a3", status: "completed", interrupted: false },
		],
		interrupted: false,
	},
} as unknown as Parameters<typeof DelegateCard>[0]["result"];

test("执行中（无 result、tasks.length=3、两个 agent）：标题显示「数据分析师等 2 名智能体执行 3 个任务」", () => {
	render(<DelegateCard sessionId="s1" toolCall={runningCall} isStreaming />);
	const header = screen.getByTestId("delegate-trun-header");
	expect(header.textContent).toContain("数据分析师等 2 名智能体");
	expect(header.textContent).toContain("3 个任务");
	// 不应回退到单任务标题
	expect(header.textContent).not.toContain("委派给");
});

test("完成态（details.subagents 3 条、2 个不同 agent）：标题同样显示多智能体格式", () => {
	render(<DelegateCard sessionId="s1" toolCall={runningCall} result={doneResult} />);
	const header = screen.getByTestId("delegate-trun-header");
	expect(header.textContent).toContain("数据分析师等 2 名智能体");
	expect(header.textContent).toContain("3 个任务");
});

test("单任务：标题仍是「委派给 X」，不回归", () => {
	const call = {
		type: "toolCall" as const,
		id: "tsingle",
		name: "delegate",
		arguments: { agent: "代码审查", task: "review diff" },
	};
	render(<DelegateCard sessionId="s1" toolCall={call} />);
	const header = screen.getByTestId("delegate-tsingle-header");
	expect(header.textContent).toContain("委派给 代码审查");
	expect(header.textContent).not.toContain("名智能体");
});

test("极老 fleet 无 agent 名（兜底）：标题仍是「并行派发 N 个任务」", () => {
	const call = {
		type: "toolCall" as const,
		id: "told",
		name: "fleet",
		arguments: {},
	};
	const result = {
		role: "toolResult" as const,
		toolCallId: "told",
		toolName: "fleet",
		content: [{ type: "text" as const, text: "完成" }],
		isError: false,
		timestamp: 0,
		details: {
			fleet: {
				"0": { status: "completed" },
				"1": { status: "completed" },
			},
			interrupted: false,
		},
	} as unknown as Parameters<typeof DelegateCard>[0]["result"];
	render(<DelegateCard sessionId="s1" toolCall={call} result={result} />);
	const header = screen.getByTestId("fleet-told-header");
	expect(header.textContent).toContain("并行派发");
	expect(header.textContent).not.toContain("名智能体");
});

test("英文文案：多智能体标题有对应翻译", async () => {
	await i18next.changeLanguage("en");
	render(<DelegateCard sessionId="s1" toolCall={runningCall} isStreaming />);
	const header = screen.getByTestId("delegate-trun-header");
	expect(header.textContent).toContain("数据分析师");
	expect(header.textContent).toContain("other agents");
	expect(header.textContent).toContain("3 task");
	await i18next.changeLanguage("zh");
});
