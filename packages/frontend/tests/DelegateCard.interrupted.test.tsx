import { test, expect, beforeEach, vi } from "bun:test";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { SubagentProgressEvent } from "@wa-pi/shared";
import { DelegateCard } from "../src/components/blocks/DelegateCard";
import { useSessionStore } from "../src/store/session";
import { useProjectsStore } from "../src/store/projects";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { useToastStore } from "../src/store/toast";
import { useUiPrefsStore } from "../src/store/ui-prefs";

// 聚焦「已中断」第三终态：成功 / 失败之外的视觉区分（琥珀警示徽标）。
// 旧会话数据无 details.interrupted 字段，必须按现有样式渲染且不报错。
// 另覆盖「父调用已终态但子代理进度仍显示运行中」的兜底：用户停止后 agent 级终态事件
// 随断流丢失、progress 停在 running → 强制归「已中断」、计时冻结在最后已知值。
beforeEach(() => {
	useSessionStore.setState({ messagesBySession: {}, progressByToolCall: {} });
	useProjectsStore.setState({ sessions: [] });
	useComposerPrefsStore.setState({ bySession: {} });
	useToastStore.setState({ toasts: [] });
	useUiPrefsStore.setState({ collapseProcessByDefault: false });
});

const call = {
	type: "toolCall" as const,
	id: "t1",
	name: "delegate",
	arguments: { agent: "代码审查", task: "review diff" },
};
// 正常完成结果（无 details 字段 = 旧数据 / 普通成功）
const result = {
	role: "toolResult" as const,
	toolCallId: "t1",
	toolName: "delegate",
	content: [{ type: "text" as const, text: "发现 2 个问题…" }],
	isError: false,
	timestamp: 0,
};

test("中断（details.interrupted=true）：meta 显示「已中断」徽标，hover 提示部分结果已保留，不再是完成态", () => {
	const interruptedResult = {
		...result,
		content: [{ type: "text" as const, text: "【部分结果】已完成前半部分审查" }],
		details: { interrupted: true },
	};
	render(
		<DelegateCard sessionId="s1" toolCall={call} result={interruptedResult} />,
	);
	const header = screen.getByTestId("delegate-t1-header");
	const badge = screen.getByTestId("interrupted-badge");
	expect(header.contains(badge)).toBe(true);
	expect(badge.getAttribute("title")).toBe("部分结果已保留");
	expect(badge.textContent).toContain("已中断");
	expect(header.textContent).not.toContain("完成");
});

test("中断态正文使用 warning 警示色（与失败 danger、成功默认色区分）", () => {
	const interruptedResult = {
		...result,
		content: [{ type: "text" as const, text: "部分结果…" }],
		details: { interrupted: true },
	};
	render(
		<DelegateCard sessionId="s1" toolCall={call} result={interruptedResult} />,
	);
	fireEvent.click(screen.getByTestId("delegate-t1-header"));
	const body = screen.getByTestId("delegate-t1-body");
	expect(body.querySelector(".text-warning")).toBeTruthy();
	expect(body.querySelector(".text-danger")).toBeNull();
});

test("失败+中断（isError 且 interrupted）：meta 归为中断徽标，正文保留失败 danger 样式", () => {
	const bothResult = {
		...result,
		isError: true,
		content: [{ type: "text" as const, text: "子代理异常中止…" }],
		details: { interrupted: true },
	};
	render(<DelegateCard sessionId="s1" toolCall={call} result={bothResult} />);
	// meta 突出中断（更值得关注），失败信息由正文承载
	expect(screen.getByTestId("interrupted-badge")).toBeTruthy();
	fireEvent.click(screen.getByTestId("delegate-t1-header"));
	expect(
		screen.getByTestId("delegate-t1-body").querySelector(".text-danger"),
	).toBeTruthy();
});

test("旧数据（无 details.interrupted 字段）：无中断徽标，meta 显示「完成」，不报错", () => {
	render(<DelegateCard sessionId="s1" toolCall={call} result={result} />);
	const header = screen.getByTestId("delegate-t1-header");
	expect(screen.queryByTestId("interrupted-badge")).toBeNull();
	expect(header.textContent).toContain("完成");
});

test("普通失败（isError 无 interrupted）：无中断徽标，保持「失败」样式", () => {
	const errResult = { ...result, isError: true };
	render(<DelegateCard sessionId="s1" toolCall={call} result={errResult} />);
	const header = screen.getByTestId("delegate-t1-header");
	expect(screen.queryByTestId("interrupted-badge")).toBeNull();
	expect(header.textContent).toContain("失败");
});

// ── 兜底：父调用已终态但子代理进度仍显示运行中 ──
// 场景：用户停止 → delegate 工具调用以终态返回（result 到达），但 agent 级终态事件随断流
// 丢失，store 里 progress 停在 running。兜底：强制归「已中断」（meta 徽标 + 摘要行文案 +
// 计时冻结在最后已知值）；details.interrupted 精确标记优先，settled 进度不受影响。

// 兜底场景进度：断流停在 running，最后推送 elapsedMs=33s
const stopProgressEvent: SubagentProgressEvent = {
	agent: "general-purpose",
	status: "running",
	output: "执行到一半…",
	tools: [{ id: "t1", name: "read", status: "done" }],
	elapsedMs: 33000,
};

test("兜底（details 缺失）：父调用终态但进度仍 running → meta 中断徽标，摘要行「已中断」+ 秒数冻结", () => {
	vi.useFakeTimers();
	const nowSpy = vi.spyOn(Date, "now").mockReturnValue(0);
	try {
		useSessionStore.setState({
			progressByToolCall: { tstop: { "0": stopProgressEvent } },
		});
		render(
			<DelegateCard
				sessionId="s1"
				toolCall={{ ...call, id: "tstop" }}
				result={{ ...result, toolCallId: "tstop" }}
			/>,
		);
		const header = screen.getByTestId("delegate-tstop-header");
		expect(
			header.querySelector('[data-testid="interrupted-badge"]'),
		).toBeTruthy();
		const summary = screen.getByTestId("delegate-progress-tstop");
		// 状态显示「已中断」而非「运行中」；秒数冻结在最后推送值 33s
		expect(summary.textContent).toContain("子智能体 · 已中断 · 33s");
		expect(summary.textContent).not.toContain("子智能体 · 运行中");
		// 本地时间前进 5s：秒数不再增长（修复前缺失兜底会持续递增到 38s）
		act(() => {
			nowSpy.mockReturnValue(5000);
			vi.advanceTimersByTime(5000);
		});
		expect(summary.textContent).toContain("33s");
		expect(summary.textContent).not.toContain("38s");
	} finally {
		nowSpy.mockRestore();
		vi.useRealTimers();
	}
});

// 2026-09-23 误标回归：kernel 已落盘 details.interrupted=false（任务真的跑完了），
// 只因终态进度帧未送达（store 停在 running）就把卡片标成「已中断」。
// 权威来源是工具结果，不能用「进度没走到终态」推翻后端明确给出的结论。
test("details.interrupted=false 为权威：进度停在 running 也不标「已中断」（按结果定性为完成）", () => {
	useSessionStore.setState({
		progressByToolCall: { tfalse: { "0": stopProgressEvent } },
	});
	render(
		<DelegateCard
			sessionId="s1"
			toolCall={{ ...call, id: "tfalse" }}
			result={{
				...result,
				toolCallId: "tfalse",
				details: { interrupted: false },
			}}
		/>,
	);
	const header = screen.getByTestId("delegate-tfalse-header");
	expect(
		header.querySelectorAll('[data-testid="interrupted-badge"]').length,
	).toBe(0);
	expect(header.textContent).toContain("完成");
	// 摘要行按结果定性（完成），不再显示「运行中」也不显示「已中断」
	const summary = screen.getByTestId("delegate-progress-tfalse");
	expect(summary.textContent).toContain("子智能体 · 完成 · 33s");
	expect(summary.textContent).not.toContain("已中断");
});

// P0-1 修复后，中止/失败路径会补发终态帧（status=error）；此时摘要行仍须按
// details.interrupted 显示「已中断」，不能被 error 的「出错」文案覆盖。
test("中断：details.interrupted=true 且进度已落终态（error）→ 徽标与摘要行仍为「已中断」", () => {
	useSessionStore.setState({
		progressByToolCall: {
			terr: { "0": { ...stopProgressEvent, status: "error" } },
		},
	});
	render(
		<DelegateCard
			sessionId="s1"
			toolCall={{ ...call, id: "terr" }}
			result={{
				...result,
				toolCallId: "terr",
				isError: true,
				details: { interrupted: true },
			}}
		/>,
	);
	const header = screen.getByTestId("delegate-terr-header");
	expect(
		header.querySelectorAll('[data-testid="interrupted-badge"]').length,
	).toBe(1);
	expect(screen.getByTestId("delegate-progress-terr").textContent).toContain(
		"已中断",
	);
});

test("回归：正常完成（进度 done + result 无 details）→ 无徽标，摘要行「完成 · 8s」", () => {
	useSessionStore.setState({
		progressByToolCall: {
			tok: { "0": { ...stopProgressEvent, status: "done", elapsedMs: 8000 } },
		},
	});
	render(
		<DelegateCard
			sessionId="s1"
			toolCall={{ ...call, id: "tok" }}
			result={{ ...result, toolCallId: "tok" }}
		/>,
	);
	const header = screen.getByTestId("delegate-tok-header");
	expect(
		header.querySelector('[data-testid="interrupted-badge"]'),
	).toBeNull();
	expect(header.textContent).toContain("完成");
	expect(screen.getByTestId("delegate-progress-tok").textContent).toContain(
		"子智能体 · 完成 · 8s",
	);
});

test("回归：运行中（无 result，进度 running）→ 兜底不触发，仍显示「运行中 · 33s」", () => {
	useSessionStore.setState({
		progressByToolCall: { trun: { "0": stopProgressEvent } },
	});
	render(<DelegateCard sessionId="s1" toolCall={{ ...call, id: "trun" }} />);
	const header = screen.getByTestId("delegate-trun-header");
	expect(
		header.querySelector('[data-testid="interrupted-badge"]'),
	).toBeNull();
	expect(screen.getByTestId("delegate-progress-trun").textContent).toContain(
		"子智能体 · 运行中 · 33s",
	);
});
