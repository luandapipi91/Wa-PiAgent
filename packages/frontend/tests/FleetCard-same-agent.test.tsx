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

// ── 同名 agent 工具统计隔离（taskIndex）──
// 复现「完成/进行中/失败一模一样」：同名 agent 多任务的进度/统计按 agent 名
// 做 key，后写覆盖先写，两个任务行显示同一份统计。修复后按 taskIndex 区分。

// C1：运行态——store 有各 taskIndex 进度，两个任务行显示各自独立工具统计
// 任务 0：2 个工具全部成功；任务 1：1 个工具失败。显示不一模一样。
test("同名 agent 任务：运行态各任务行显示各自独立工具统计（不一模一样）", () => {
	useSessionStore.setState({
		progressByToolCall: {
			frun: {
				"0": {
					agent: "Explore",
					status: "running",
					output: "",
					elapsedMs: 1,
					tools: [
						{ id: "t1", name: "read", status: "done" },
						{ id: "t2", name: "read", status: "done" },
					],
				},
				"1": {
					agent: "Explore",
					status: "running",
					output: "",
					elapsedMs: 1,
					tools: [{ id: "t3", name: "grep", status: "error" }],
				},
			},
		},
	});
	const call = {
		type: "toolCall" as const,
		id: "frun",
		name: "fleet",
		arguments: {
			tasks: [
				{ agent: "Explore", task: "A" },
				{ agent: "Explore", task: "B" },
			],
		},
	};
	render(<FleetCard sessionId="s1" toolCall={call} />);
	// 运行态 hasProgress=true，卡片默认已展开（无需点 header）
	expect(screen.getByText(/调用了 2 个工具/)).toBeTruthy();
	expect(screen.getByText(/调用了 1 个工具/)).toBeTruthy();
});

// C2：完成态——details.fleet 按任务序号 key，同名 agent 各显示各自统计
test("同名 agent 完成态：details.fleet 按序号 key，各任务显示各自统计", () => {
	const call = {
		type: "toolCall" as const,
		id: "fdone",
		name: "fleet",
		arguments: {
			tasks: [
				{ agent: "Explore", task: "A" },
				{ agent: "Explore", task: "B" },
			],
		},
	};
	const result = {
		role: "toolResult" as const,
		toolCallId: "fdone",
		toolName: "fleet",
		content: [
			{
				type: "text" as const,
				text: "【Explore】A done\n\n【Explore】B done",
			},
		],
		isError: false,
		timestamp: 0,
		details: {
			fleet: {
				"0": { total: 3, done: 2, error: 1, running: 0 },
				"1": { total: 5, done: 5, error: 0, running: 0 },
			},
		},
	} as any;
	render(<FleetCard sessionId="s1" toolCall={call} result={result} />);
	fireEvent.click(screen.getByTestId("fleet-fdone-header"));
	// 完成态 label：已完成 调用了 X 个工具…。任务 0=3，任务 1=5，不同
	expect(screen.getByText(/调用了 3 个工具/)).toBeTruthy();
	expect(screen.getByText(/调用了 5 个工具/)).toBeTruthy();
});

// C3：老数据兼容——details.fleet 按名字 key（新代码上线前的历史会话）
// 同名 agent 只有一份统计（无法区分），但不得崩溃，回复仍正确拆分不串台
test("老数据 details.fleet 按名字 key 时降级（不崩溃，回复不串台）", () => {
	const call = {
		type: "toolCall" as const,
		id: "fold",
		name: "fleet",
		arguments: {
			tasks: [
				{ agent: "Explore", task: "A" },
				{ agent: "Explore", task: "B" },
			],
		},
	};
	const result = {
		role: "toolResult" as const,
		toolCallId: "fold",
		toolName: "fleet",
		content: [
			{
				type: "text" as const,
				text: "【Explore】A done\n\n【Explore】B done",
			},
		],
		isError: false,
		timestamp: 0,
		details: {
			fleet: { Explore: { total: 1, done: 1, error: 0, running: 0 } },
		},
	} as any;
	// 不应崩溃
	render(<FleetCard sessionId="s1" toolCall={call} result={result} />);
	fireEvent.click(screen.getByTestId("fleet-fold-header"));
	// 回复仍正确拆分：展开任务 1 看到 A done（不串台）
	const rows = screen.getAllByRole("button", { name: /展开|▶/ });
	fireEvent.click(rows[0]);
	expect(screen.getByText(/A done/)).toBeTruthy();
	expect(screen.queryByText(/B done/)).toBeNull();
});
