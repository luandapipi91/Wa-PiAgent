import { test, expect, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { FleetCard } from "../src/components/blocks/FleetCard";
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

// 复现场景：LLM 把两个独立任务派给同一个 agent（同名 agent 任务）
const dupCall = {
	type: "toolCall" as const,
	id: "fdup",
	name: "fleet",
	arguments: {
		tasks: [
			{ agent: "前端开发者", task: "写 A 页面" },
			{ agent: "前端开发者", task: "写 B 页面" },
		],
	},
};

const dupResult = {
	role: "toolResult" as const,
	toolCallId: "fdup",
	toolName: "fleet",
	content: [
		{
			type: "text" as const,
			text: "【前端开发者】A 页面完成\n\n【前端开发者】B 页面完成",
		},
	],
	isError: false,
	timestamp: 0,
};

test("同名 agent 任务：展开任务 1 应显示任务 1 的回复（A 页面完成），不得显示任务 2 的", () => {
	render(<FleetCard sessionId="s1" toolCall={dupCall} result={dupResult} />);
	fireEvent.click(screen.getByTestId("fleet-fdup-header"));

	const rows = screen.getAllByRole("button", { name: /展开|▶/ });
	expect(rows.length).toBe(2);
	fireEvent.click(rows[0]);

	// 任务 1 展开后应显示 A 页面完成
	expect(screen.getByText(/A 页面完成/)).toBeTruthy();
	// 不得显示任务 2 的回复（串台）
	expect(screen.queryByText(/B 页面完成/)).toBeNull();
});

test("同名 agent 任务：展开任务 2 应显示任务 2 的回复（B 页面完成）", () => {
	render(<FleetCard sessionId="s1" toolCall={dupCall} result={dupResult} />);
	fireEvent.click(screen.getByTestId("fleet-fdup-header"));

	const rows = screen.getAllByRole("button", { name: /展开|▶/ });
	fireEvent.click(rows[1]);

	expect(screen.getByText(/B 页面完成/)).toBeTruthy();
	expect(screen.queryByText(/A 页面完成/)).toBeNull();
});

test("不同 agent 任务：各任务展开显示各自回复（回归保护）", () => {
	const call = {
		type: "toolCall" as const,
		id: "fdiff",
		name: "fleet",
		arguments: {
			tasks: [
				{ agent: "代码审查", task: "review diff" },
				{ agent: "前端开发", task: "重构 UI" },
			],
		},
	};
	const result = {
		role: "toolResult" as const,
		toolCallId: "fdiff",
		toolName: "fleet",
		content: [
			{
				type: "text" as const,
				text: "【代码审查】review 通过\n\n【前端开发】UI 已重构",
			},
		],
		isError: false,
		timestamp: 0,
	};
	render(<FleetCard sessionId="s1" toolCall={call} result={result} />);
	fireEvent.click(screen.getByTestId("fleet-fdiff-header"));

	const rows = screen.getAllByRole("button", { name: /展开|▶/ });
	fireEvent.click(rows[0]);
	expect(screen.getByText(/review 通过/)).toBeTruthy();
	expect(screen.queryByText(/UI 已重构/)).toBeNull();

	// 收起任务 1，再展开任务 2
	fireEvent.click(screen.getByRole("button", { name: /折叠|▼/ }));
	const rows2 = screen.getAllByRole("button", { name: /展开|▶/ });
	fireEvent.click(rows2[1]);
	expect(screen.getByText(/UI 已重构/)).toBeTruthy();
	expect(screen.queryByText(/review 通过/)).toBeNull();
});
