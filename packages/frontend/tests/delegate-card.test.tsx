import { test, expect, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import type { SessionMessage } from "@wa-pi/shared";
import { VirtuosoMockContext } from "react-virtuoso";
import { DelegateCard } from "../src/components/blocks/DelegateCard";
import { MessageList } from "../src/components/MessageList";
import { useSessionStore } from "../src/store/session";
import { useUiPrefsStore } from "../src/store/ui-prefs";

// 统一委托卡片（FleetCard 已并入 DelegateCard）的三种数据形状 + 「查看全部内容」门控。
// 形状判定完全按运行时 details：
//  - 新数据：details.subagents（数组），转录路径取 details.subagents[].jsonlPath；
//  - 旧 delegate：只有布尔 details.interrupted（那时没落盘，无转录可看）；
//  - 旧 fleet：details.fleet（按序号统计）+ 聚合文本按 【agent】 切分。
// 门控：agentId 与 jsonlPath **都**非空才渲染按钮——越权行 agentId 为空、转录目录/meta 准备
// 失败的行 jsonlPath 为空，这两类行点了必然 404。
// 回归保护：新数据的返回文本**刻意不含** <agent_id>/<transcript> XML——若前端又去解析返回
// 文本（模型可见的契约面），这些用例的按钮会直接消失而失败。

beforeEach(() => {
	useSessionStore.setState({ progressByToolCall: {}, transcript: null });
	// 基线为「回复过程折叠开关关闭」；完成态卡片默认折叠，断言前先点头部展开
	useUiPrefsStore.setState({ collapseProcessByDefault: false });
});

/** 新数据返回块：转录路径只在 details.subagents[].jsonlPath（前端唯一数据来源）。
 *  返回文本刻意用非 XML 的普通句子——证明前端不再解析模型可见文本。 */
function newShapeResult(opts: {
	agentId?: string;
	jsonlPath?: string;
	interrupted?: boolean;
	status?: "completed" | "failed" | "interrupted";
	text?: string;
} = {}) {
	const {
		agentId = "a3f8c1d0a",
		jsonlPath: path = "/abs/subagents/s1/a3f8c1d0a.jsonl",
		status = "completed",
	} = opts;
	return {
		role: "toolResult" as const,
		toolCallId: "call_1",
		toolName: "delegate",
		content: [
			{ type: "text" as const, text: opts.text ?? "结论 X（模型可见文本，非前端数据源）" },
		],
		isError: false,
		timestamp: 0,
		details: {
			subagents: [
				{
					taskIndex: 0,
					agentId,
					jsonlPath: path,
					agent: "Explore",
					subagentType: "Explore",
					resumed: false,
					status,
					toolStats: { total: 2, done: 2, error: 0, running: 0 },
					interrupted: opts.interrupted ?? false,
				},
			],
			interrupted: opts.interrupted ?? false,
		},
	} as never;
}

const newCall = {
	type: "toolCall" as const,
	id: "call_1",
	name: "delegate",
	arguments: { tasks: [{ agent: "Explore", task: "查 X" }] },
};

test("新数据（details.subagents）：任务行整行可点 → 打开弹窗（文字入口已移除）", () => {
	render(
		<DelegateCard sessionId="s1" toolCall={newCall} result={newShapeResult()} />,
	);
	// 完成态默认折叠 → 展开后才看得到任务行与入口
	fireEvent.click(screen.getByTestId("delegate-call_1-header"));
	// 任务清单行（agent + task）与聚合回复都不含 agent 名的误解：标题也带 agent 名，故按任务文本断言
	expect(screen.getByText(/委派给 Explore/)).toBeTruthy();
	expect(screen.getByText("查 X")).toBeTruthy();
	// 新数据的任务行：持久化终态 + 工具统计
	expect(screen.getByText(/任务 1：已完成 调用了 2 个工具 成功 2 失败 0 执行中 0/)).toBeTruthy();
	// 2026-10-02：不再有「查看全部内容」文字入口，唯一入口是任务行本身
	expect(screen.queryByRole("button", { name: /查看全部内容/ })).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: /委托转录 Explore/ }));
	expect(useSessionStore.getState().transcript).toEqual({
		sessionId: "s1",
		agentId: "a3f8c1d0a",
	});
});

test("门控①：越权行（agentId 与 jsonlPath 都为空）→ 任务行不可点（点了也打不开）", () => {
	render(
		<DelegateCard
			sessionId="s1"
			toolCall={newCall}
			result={newShapeResult({ agentId: "", jsonlPath: "" })}
		/>,
	);
	fireEvent.click(screen.getByTestId("delegate-call_1-header"));
	// 任务行照常渲染（用户要知道派过什么），但不能给出必然 404 的入口
	expect(screen.getByText("查 X")).toBeTruthy();
	expect(screen.queryByRole("button", { name: /委托转录/ })).toBeNull();
	expect(useSessionStore.getState().transcript).toBeNull();
});

test("门控②：agentId 非空但 jsonlPath 为空（转录目录/meta 准备失败）→ 任务行不可点", () => {
	render(
		<DelegateCard
			sessionId="s1"
			toolCall={newCall}
			result={newShapeResult({ agentId: "a3f8c1d0a", jsonlPath: "" })}
		/>,
	);
	fireEvent.click(screen.getByTestId("delegate-call_1-header"));
	expect(screen.getByText("查 X")).toBeTruthy();
	expect(screen.queryByRole("button", { name: /委托转录/ })).toBeNull();
	expect(useSessionStore.getState().transcript).toBeNull();
});

test("中断态（status=interrupted）：任务行同样可点开弹窗（与完成态行为一致）", () => {
	// 用户报告的缺陷：中断卡片没有查看入口。门控只认「有没有可查的转录」两个字段，
	// 与终态无关——中断实例的 jsonl 同样已落盘；若将来有人给入口加「仅完成态」条件，本用例会红。
	render(
		<DelegateCard
			sessionId="s1"
			toolCall={newCall}
			result={newShapeResult({ interrupted: true, status: "interrupted" })}
		/>,
	);
	// 终态默认折叠 → 展开后才看得到任务行与入口
	fireEvent.click(screen.getByTestId("delegate-call_1-header"));
	expect(screen.getByText("查 X")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: /委托转录 Explore/ }));
	expect(useSessionStore.getState().transcript).toEqual({
		sessionId: "s1",
		agentId: "a3f8c1d0a",
	});
});

test("执行中（只有进度事件、details 还没到）→ 任务行可点，用进度里的 agentId 打开弹窗", () => {
	useSessionStore.setState({
		progressByToolCall: {
			call_1: {
				"0": {
					agent: "Explore",
					agentId: "a1234567b",
					status: "running",
					output: "进行中的输出",
					tools: [],
					elapsedMs: 1000,
				},
			},
		},
	});
	// 无 result：details 还没到，入口只能靠进度事件里的 agentId
	render(<DelegateCard sessionId="s1" toolCall={newCall} />);
	fireEvent.click(screen.getByRole("button", { name: /委托转录 Explore/ }));
	expect(useSessionStore.getState().transcript).toEqual({
		sessionId: "s1",
		agentId: "a1234567b",
	});
});

test("新数据：卡片上不渲染回复正文（正文只在转录弹窗里看）", () => {
	render(
		<DelegateCard
			sessionId="s1"
			toolCall={newCall}
			result={newShapeResult({ text: "结论 X（模型可见文本，非前端数据源）" })}
		/>,
	);
	fireEvent.click(screen.getByTestId("delegate-call_1-header"));
	// 任务清单还在（用户要知道派过什么），但正文不再就地展开
	expect(screen.getByText("查 X")).toBeTruthy();
	expect(screen.queryByText(/结论 X/)).toBeNull();
});

test("旧 delegate 数据（无 subagents）：不出现查看入口，回复照旧渲染", () => {
	render(
		<DelegateCard
			sessionId="s1"
			toolCall={
				{
					type: "toolCall",
					id: "call_2",
					name: "delegate",
					arguments: { agent: "Explore", task: "旧" },
				} as never
			}
			result={
				{
					role: "toolResult",
					toolCallId: "call_2",
					toolName: "delegate",
					content: [{ type: "text", text: "旧结果" }],
					isError: false,
					timestamp: 0,
					details: { interrupted: false },
				} as never
			}
		/>,
	);
	expect(screen.queryByRole("button", { name: /委托转录/ })).toBeNull();
	fireEvent.click(screen.getByTestId("delegate-call_2-header"));
	expect(screen.getByText("旧结果")).toBeTruthy();
});

test("旧 fleet 数据（details.fleet）：按序号配对 tasks 渲染且无查看按钮", () => {
	render(
		<DelegateCard
			sessionId="s1"
			toolCall={
				{
					type: "toolCall",
					id: "call_3",
					name: "fleet",
					arguments: {
						tasks: [
							{ agent: "Explore", task: "a" },
							{ agent: "Plan", task: "b" },
						],
					},
				} as never
			}
			result={
				{
					role: "toolResult",
					toolCallId: "call_3",
					toolName: "fleet",
					content: [
						{ type: "text", text: "【Explore】\n结论A\n\n【Plan】\n结论B" },
					],
					isError: false,
					timestamp: 0,
					details: {
						fleet: { "0": { total: 2, done: 2, error: 0, running: 0 } },
						interrupted: { "0": false, "1": false },
					},
				} as never
			}
		/>,
	);
	fireEvent.click(screen.getByTestId("fleet-call_3-header"));
	expect(screen.getByText(/Explore/)).toBeTruthy();
	// 序号 0 有持久化统计、序号 1 走「已完成 · 点击查看回复」降级口径
	expect(screen.getByText(/任务 1：已完成 调用了 2 个工具 成功 2 失败 0 执行中 0/)).toBeTruthy();
	expect(screen.getByText(/任务 2：已完成 · 点击查看回复/)).toBeTruthy();
	expect(screen.queryByRole("button", { name: /查看全部内容/ })).toBeNull();
});

test("MessageList：delegate 与历史 fleet 调用都渲染为统一委托卡片", () => {
	const assistantMsg = (content: any[], ts: number): SessionMessage => ({
		agentName: "product",
		message: { role: "assistant", content, model: "pi-test", stopReason: "end_turn", timestamp: ts },
	});
	useSessionStore.setState({
		messagesBySession: {
			s1: [
				assistantMsg(
					[
						{ type: "toolCall", id: "d1", name: "delegate", arguments: { tasks: [{ agent: "Explore", task: "查 X" }] } },
					],
					1,
				),
				assistantMsg(
					[
						{ type: "toolCall", id: "f1", name: "fleet", arguments: { tasks: [{ agent: "Plan", task: "b" }] } },
					],
					2,
				),
			],
		},
	});
	render(
		<VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 60 }}>
			<MessageList sessionId="s1" />
		</VirtuosoMockContext.Provider>,
	);
	// 轮级折叠：已定稿行过程段默认折叠进摘要行，逐条展开后断言统一卡片
	for (const summary of screen.getAllByTestId("turn-summary")) {
		fireEvent.click(summary);
	}
	expect(screen.getByTestId("delegate-d1")).toBeTruthy();
	expect(screen.getByTestId("fleet-f1")).toBeTruthy();
	// 两张卡都带统一卡片的稳定选择器；普通工具卡不出现
	expect(screen.getAllByTestId("delegate-card")).toHaveLength(2);
});
