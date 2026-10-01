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
//  - 新数据：details.subagents（数组）+ XML 返回块里的 <transcript> 路径；
//  - 旧 delegate：只有布尔 details.interrupted（那时没落盘，无转录可看）；
//  - 旧 fleet：details.fleet（按序号统计）+ 聚合文本按 【agent】 切分。
// 门控：agentId 与转录路径**都**非空才渲染按钮——越权行 agentId 为空、转录目录/meta 准备
// 失败的行 <transcript> 为空，这两类行点了必然 404。

beforeEach(() => {
	useSessionStore.setState({ progressByToolCall: {}, transcript: null });
	// 基线为「回复过程折叠开关关闭」；完成态卡片默认折叠，断言前先点头部展开
	useUiPrefsStore.setState({ collapseProcessByDefault: false });
});

/** 新数据返回块的 XML 文本（kernel delegate-tool 的真实格式，逐字段同行紧凑排版） */
function subagentXml(opts: {
	index?: number;
	agentId?: string;
	transcript?: string;
	result?: string;
}): string {
	const {
		index = 0,
		agentId = "a3f8c1d0a",
		transcript = "/abs/subagents/s1/a3f8c1d0a.jsonl",
		result = "结论 X",
	} = opts;
	return (
		`<subagent><index>${index}</index><agent_id>${agentId}</agent_id>` +
		`<type>Explore</type><status>completed</status><elapsed>1.2s</elapsed>` +
		`<tokens>1.0k</tokens><resumed>false</resumed>` +
		`<transcript>${transcript}</transcript><result>\n${result}\n</result></subagent>`
	);
}

function newShapeResult(opts: {
	agentId?: string;
	transcript?: string;
	xml?: string;
	interrupted?: boolean;
} = {}) {
	const { agentId = "a3f8c1d0a", transcript, xml } = opts;
	return {
		role: "toolResult" as const,
		toolCallId: "call_1",
		toolName: "delegate",
		content: [{ type: "text" as const, text: xml ?? subagentXml({ agentId, transcript }) }],
		isError: false,
		timestamp: 0,
		details: {
			subagents: [
				{
					taskIndex: 0,
					agentId,
					agent: "Explore",
					subagentType: "Explore",
					resumed: false,
					status: "completed",
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

test("新数据（details.subagents）：渲染任务行 + 「查看全部内容」，点击写入 store 目标实例", () => {
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
	// 入口按钮
	const btn = screen.getByRole("button", { name: /查看全部内容/ });
	expect(btn.getAttribute("aria-label")).toBe("查看全部内容 Explore");
	fireEvent.click(btn);
	expect(useSessionStore.getState().transcript).toEqual({
		sessionId: "s1",
		agentId: "a3f8c1d0a",
	});
});

test("门控①：越权行（agentId 为空且 <transcript> 为空）→ 无「查看全部内容」按钮", () => {
	render(
		<DelegateCard
			sessionId="s1"
			toolCall={newCall}
			result={newShapeResult({
				agentId: "",
				xml: subagentXml({ agentId: "", transcript: "", result: "错误：无委派权限" }),
			})}
		/>,
	);
	fireEvent.click(screen.getByTestId("delegate-call_1-header"));
	// 任务行照常渲染（用户要知道派过什么），但不能给出必然 404 的入口
	expect(screen.getByText("查 X")).toBeTruthy();
	expect(screen.queryByRole("button", { name: /查看全部内容/ })).toBeNull();
});

test("门控②：agentId 非空但 <transcript> 为空（转录目录/meta 准备失败）→ 无按钮", () => {
	render(
		<DelegateCard
			sessionId="s1"
			toolCall={newCall}
			result={newShapeResult({ agentId: "a3f8c1d0a", transcript: "" })}
		/>,
	);
	fireEvent.click(screen.getByTestId("delegate-call_1-header"));
	expect(screen.getByText("查 X")).toBeTruthy();
	expect(screen.queryByRole("button", { name: /查看全部内容/ })).toBeNull();
});

test("旧 delegate 数据（无 subagents）：不出现查看按钮，回复照旧渲染", () => {
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
	expect(screen.queryByRole("button", { name: /查看全部内容/ })).toBeNull();
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
