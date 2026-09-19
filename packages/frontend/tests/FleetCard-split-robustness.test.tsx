import { test, expect, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { FleetCard } from "../src/components/blocks/FleetCard";
import { useSessionStore } from "../src/store/session";
import { useProjectsStore } from "../src/store/projects";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { useToastStore } from "../src/store/toast";
import { useUiPrefsStore } from "../src/store/ui-prefs";

// 回归（用户反馈）：fleet 卡片「有正式回复，但底部任务行还有空的回复」。
// 两类根因：①聚合正文里 agent 自带的【】小标题 / 用户停止的「已停止。」前缀，会让
// 整段文本无法按任务拆分 → 卡片降级、任务行没有逐任务回复却仍渲染空「回复：」块；
// ②降级态任务行仍承诺「点击查看回复」但没有可展开内容。
beforeEach(() => {
	useSessionStore.setState({ messagesBySession: {}, progressByToolCall: {} });
	useProjectsStore.setState({ sessions: [] });
	useComposerPrefsStore.setState({ bySession: {} });
	useToastStore.setState({ toasts: [] });
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

test("拆分鲁棒性：正文自带的【】小标题不参与切分，各任务显示各自回复", () => {
	const splitResult = {
		...fleetResult,
		content: [
			{
				type: "text" as const,
				text: [
					"【代码审查】review 通过，附交叉验证：",
					"",
					"## 【代理A·质数计算】任务结果",
					"",
					"表格片段",
					"",
					"【前端开发】UI 已重构",
				].join("\n"),
			},
		],
	};
	render(<FleetCard sessionId="s1" toolCall={fleetCall} result={splitResult} />);
	fireEvent.click(screen.getByTestId("fleet-f1-header"));
	// 拆分成功：不渲染聚合回复块（回复按任务行展开）
	expect(screen.queryByTestId("text-block")).toBeNull();
	const rows = screen.getAllByRole("button", { name: /展开|▶/ });
	expect(rows).toHaveLength(2);
	// 点开任务 1：正文完整保留（含自带【】小标题），且不含任务 2 的回复
	fireEvent.click(rows[0]);
	expect(screen.getByText(/review 通过/)).toBeTruthy();
	expect(screen.getByText(/代理A·质数计算/)).toBeTruthy();
	expect(screen.queryByText(/UI 已重构/)).toBeNull();
});

test("拆分鲁棒性：「已停止。」前缀不阻碍拆分（用户停止场景仍按任务显示部分进度）", () => {
	const stoppedResult = {
		...fleetResult,
		content: [
			{
				type: "text" as const,
				text: "已停止。【代码审查】（中断）\n已中止的审查内容\n\n【前端开发】（中断）\n已中止的开发内容",
			},
		],
	};
	render(<FleetCard sessionId="s1" toolCall={fleetCall} result={stoppedResult} />);
	fireEvent.click(screen.getByTestId("fleet-f1-header"));
	expect(screen.queryByTestId("text-block")).toBeNull();
	const rows = screen.getAllByRole("button", { name: /展开|▶/ });
	fireEvent.click(rows[0]);
	expect(screen.getByText(/已中止的审查内容/)).toBeTruthy();
	expect(screen.queryByText(/已中止的开发内容/)).toBeNull();
});

test("降级聚合（无法拆分）：任务行不显示「点击查看回复」后缀，点击不出现空「回复：」块", () => {
	const degraded = {
		...fleetResult,
		// 正文无【】标记 → 拆分降级为聚合显示
		details: {
			fleet: {
				代码审查: { total: 3, done: 2, error: 1, running: 0 },
				前端开发: { total: 1, done: 1, error: 0, running: 0 },
			},
		},
	};
	render(<FleetCard sessionId="s1" toolCall={fleetCall} result={degraded} />);
	fireEvent.click(screen.getByTestId("fleet-f1-header"));
	// 聚合回复区（正式回复）仍可见
	expect(screen.getByTestId("text-block")).toBeTruthy();
	// 统计行如实显示计数，但不承诺「点击查看回复」（逐任务回复不可用）
	expect(
		screen.getByText(/任务 1：已完成 调用了 3 个工具 成功 2 失败 1 执行中 0/),
	).toBeTruthy();
	expect(screen.queryByText(/点击查看回复/)).toBeNull();
	// 「回复：」只出现 1 处（聚合区）
	expect(screen.getAllByText("回复：")).toHaveLength(1);
	// 任务行不可展开：点击后也不会冒出第二个空「回复：」块
	const body = screen.getByTestId("fleet-f1-body");
	const row1 = Array.from(body.querySelectorAll("button")).find((b) =>
		b.textContent?.includes("任务 1"),
	);
	expect(row1).toBeTruthy();
	expect(row1!.getAttribute("aria-label")).toBeNull();
	fireEvent.click(row1!);
	expect(screen.getAllByText("回复：")).toHaveLength(1);
});
