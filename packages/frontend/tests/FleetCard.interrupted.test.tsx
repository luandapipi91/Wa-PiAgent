import { test, expect, beforeEach, vi } from "bun:test";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { SubagentProgressEvent } from "@wa-pi/shared";
import { FleetCard } from "../src/components/blocks/FleetCard";
import { useSessionStore } from "../src/store/session";
import { useProjectsStore } from "../src/store/projects";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { useToastStore } from "../src/store/toast";
import { useUiPrefsStore } from "../src/store/ui-prefs";

// 聚焦 fleet 卡片的子任务级「已中断」徽标：details.interrupted 按任务序号（String(index)）映射。
// 旧会话数据 details 无 interrupted 字段（或整字段缺失），必须与现状渲染一致且不报错。
// 另覆盖「父调用已终态但子任务行仍显示运行中」的兜底：用户停止后 agent 级终态事件随断流
// 丢失、progress 停在 running → 行强制归为「已中断」、计时冻结在最后已知值（settled 行不受影响）。
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
// 完成态持久化统计（details.fleet 按任务序号），子任务行可见性依赖 stats
const fleetStats = {
	"0": { total: 3, done: 2, error: 1, running: 0 },
	"1": { total: 2, done: 2, error: 0, running: 0 },
};
const baseResult = {
	role: "toolResult" as const,
	toolCallId: "f1",
	toolName: "fleet",
	content: [{ type: "text" as const, text: "并行任务结束" }],
	isError: false,
	timestamp: 0,
};

test("子任务中断（details.interrupted 按序号映射）：meta 与中断行各有「已中断」徽标，未中断行没有", () => {
	const interruptedResult = {
		...baseResult,
		details: { fleet: fleetStats, interrupted: { "0": true, "1": false } },
	};
	render(
		<FleetCard sessionId="s1" toolCall={fleetCall} result={interruptedResult} />,
	);
	// 头部 meta 有中断徽标
	const header = screen.getByTestId("fleet-f1-header");
	expect(
		header.querySelector('[data-testid="interrupted-badge"]'),
	).toBeTruthy();
	// 展开后看子任务行
	fireEvent.click(header);
	const badges = screen.getAllByTestId("interrupted-badge");
	// meta 1 个 + 任务 1 行 1 个
	expect(badges).toHaveLength(2);
	// 第 2 个徽标位于「任务 1」行按钮内
	const row1Btn = badges[1].closest("button");
	expect(row1Btn?.textContent).toContain("任务 1");
	// 「任务 2」行按钮内无徽标（interrupted["1"]=false）
	const body = screen.getByTestId("fleet-f1-body");
	const row2Btn = Array.from(body.querySelectorAll("button")).find((b) =>
		b.textContent?.includes("任务 2"),
	);
	expect(row2Btn).toBeTruthy();
	expect(
		row2Btn!.querySelector('[data-testid="interrupted-badge"]'),
	).toBeNull();
});

test("全部子任务中断：meta 1 个 + 每行各 1 个徽标", () => {
	const allInterruptedResult = {
		...baseResult,
		details: { fleet: fleetStats, interrupted: { "0": true, "1": true } },
	};
	render(
		<FleetCard
			sessionId="s1"
			toolCall={fleetCall}
			result={allInterruptedResult}
		/>,
	);
	fireEvent.click(screen.getByTestId("fleet-f1-header"));
	const badges = screen.getAllByTestId("interrupted-badge");
	expect(badges).toHaveLength(3);
	// 两个任务行的按钮都含徽标
	const body = screen.getByTestId("fleet-f1-body");
	const rowsWithBadge = Array.from(body.querySelectorAll("button")).filter(
		(b) => b.querySelector('[data-testid="interrupted-badge"]'),
	);
	expect(rowsWithBadge).toHaveLength(2);
});

test("旧数据（details 只有 fleet 统计、无 interrupted 字段）：无中断徽标，meta 显示「完成」，不报错", () => {
	const oldResult = { ...baseResult, details: { fleet: fleetStats } };
	render(<FleetCard sessionId="s1" toolCall={fleetCall} result={oldResult} />);
	const header = screen.getByTestId("fleet-f1-header");
	expect(screen.queryByTestId("interrupted-badge")).toBeNull();
	expect(header.textContent).toContain("完成");
	// 子任务行照常渲染（stats 可见），行内无徽标
	fireEvent.click(header);
	expect(screen.getByTestId("fleet-f1-body").textContent).toContain("任务 1");
	expect(screen.queryByTestId("interrupted-badge")).toBeNull();
});

test("details 整体缺失（更老的数据）：无中断徽标、meta「完成」、不报错", () => {
	render(<FleetCard sessionId="s1" toolCall={fleetCall} result={baseResult} />);
	const header = screen.getByTestId("fleet-f1-header");
	expect(screen.queryByTestId("interrupted-badge")).toBeNull();
	expect(header.textContent).toContain("完成");
});

// ── 兑底：父调用已终态但子任务行仍显示运行中 ──
// 场景：用户停止 → fleet 工具调用以终态返回（result 到达），但 agent 级终态事件随断流丢失，
// store 里 progress 停在 running。兑底：running 行强制归「已中断」（徽标 + 状态行文案 +
// 计时冻结在最后已知值），settled 行维持原有成功/失败样式。

// 兑底场景进度：任务 0 断流停在 running（最后推送 33s）；任务 1 已正常 settle（done，8s）
const stopProgress: Record<string, Record<string, SubagentProgressEvent>> = {
	fstop: {
		"0": {
			agent: "general-purpose",
			status: "running",
			output: "执行到一半…",
			tools: [{ id: "t1", name: "read", status: "done" }],
			elapsedMs: 33000,
		},
		"1": {
			agent: "researcher",
			status: "done",
			output: "已完成",
			tools: [],
			elapsedMs: 8000,
		},
	},
};
const stopCall = {
	type: "toolCall" as const,
	id: "fstop",
	name: "fleet",
	arguments: {
		tasks: [
			{ agent: "general-purpose", task: "搜集资料" },
			{ agent: "researcher", task: "写报告" },
		],
	},
};

// 从卡片 body 里按「任务 N」文案找子任务行开关按钮
function findRowBtn(body: HTMLElement, label: string): HTMLButtonElement {
	const btn = Array.from(body.querySelectorAll("button")).find((b) =>
		b.textContent?.includes(label),
	);
	expect(btn).toBeTruthy();
	return btn as HTMLButtonElement;
}

test("兑底（details 缺失）：父调用终态但行 progress 仍 running → 行强制「已中断」，settled 行不受影响", () => {
	useSessionStore.setState({ progressByToolCall: stopProgress });
	render(<FleetCard sessionId="s1" toolCall={stopCall} result={baseResult} />);
	// 头部 meta：兑底命中 → 中断徽标（中断优先于完成/失败展示）
	const header = screen.getByTestId("fleet-fstop-header");
	expect(
		header.querySelector('[data-testid="interrupted-badge"]'),
	).toBeTruthy();
	// 有 progress 时卡片默认已展开（hasProgress → open=true），无需点 header（点了反而折叠）
	const body = screen.getByTestId("fleet-fstop-body");
	expect(
		findRowBtn(body, "任务 1").querySelector(
			'[data-testid="interrupted-badge"]',
		),
	).toBeTruthy();
	expect(
		findRowBtn(body, "任务 2").querySelector(
			'[data-testid="interrupted-badge"]',
		),
	).toBeNull();
	// 展开任务 1 行：状态行显示「已中断」而非「运行中」，秒数冻结在最后推送值 33s
	fireEvent.click(findRowBtn(body, "任务 1"));
	expect(body.textContent).toContain("general-purpose · 已中断 · 33s");
	expect(body.textContent).not.toContain("general-purpose · 运行中");
});

test("兑底冻结计时：父调用终态后秒数停在最后已知值，本地时间前进不再增长", () => {
	vi.useFakeTimers();
	const nowSpy = vi.spyOn(Date, "now").mockReturnValue(0);
	try {
		useSessionStore.setState({ progressByToolCall: stopProgress });
		render(
			<FleetCard sessionId="s1" toolCall={stopCall} result={baseResult} />,
		);
		// 有 progress 时卡片默认已展开，直接取 body
		const body = screen.getByTestId("fleet-fstop-body");
		fireEvent.click(findRowBtn(body, "任务 1"));
		// 冻结在最后一次推送的 elapsedMs（33s）
		expect(body.textContent).toContain("general-purpose · 已中断 · 33s");
		// 本地时间前进 5s：秒数不增长（修复前缺失兑底会持续递增到 38s）
		act(() => {
			nowSpy.mockReturnValue(5000);
			vi.advanceTimersByTime(5000);
		});
		expect(body.textContent).toContain("general-purpose · 已中断 · 33s");
		expect(body.textContent).not.toContain("38s");
	} finally {
		nowSpy.mockRestore();
		vi.useRealTimers();
	}
});

test("details 与兑底并存：true 行精确标记徽标，false+settled 行维持成功样式（兑底不误伤）", () => {
	useSessionStore.setState({ progressByToolCall: stopProgress });
	const preciseResult = {
		...baseResult,
		details: {
			fleet: {
				"0": { total: 1, done: 1, error: 0, running: 0 },
				"1": { total: 1, done: 1, error: 0, running: 0 },
			},
			interrupted: { "0": true, "1": false },
		},
	};
	render(
		<FleetCard sessionId="s1" toolCall={stopCall} result={preciseResult} />,
	);
	// 有 progress 时卡片默认已展开，直接取 body
	const body = screen.getByTestId("fleet-fstop-body");
	expect(
		findRowBtn(body, "任务 1").querySelector(
			'[data-testid="interrupted-badge"]',
		),
	).toBeTruthy();
	expect(
		findRowBtn(body, "任务 2").querySelector(
			'[data-testid="interrupted-badge"]',
		),
	).toBeNull();
});

test("回归：父调用终态且各行均已 settle（正常完成路径）→ 无兑底误伤，渲染与改动前一致", () => {
	useSessionStore.setState({
		progressByToolCall: {
			fok: {
				"0": {
					agent: "general-purpose",
					status: "done",
					output: "ok",
					tools: [],
					elapsedMs: 5000,
				},
				"1": {
					agent: "researcher",
					status: "error",
					output: "bad",
					tools: [],
					elapsedMs: 3000,
				},
			},
		},
	});
	render(
		<FleetCard
			sessionId="s1"
			toolCall={{ ...stopCall, id: "fok" }}
			result={baseResult}
		/>,
	);
	const header = screen.getByTestId("fleet-fok-header");
	expect(screen.queryByTestId("interrupted-badge")).toBeNull();
	expect(header.textContent).toContain("完成");
	// 有 progress 时卡片默认已展开，直接取 body
	const body = screen.getByTestId("fleet-fok-body");
	// settled 行状态行维持原有终态文案（done→完成 / error→出错），秒数为后端终值
	fireEvent.click(findRowBtn(body, "任务 1"));
	expect(body.textContent).toContain("general-purpose · 完成 · 5s");
	fireEvent.click(findRowBtn(body, "任务 2"));
	expect(body.textContent).toContain("researcher · 出错 · 3s");
});
