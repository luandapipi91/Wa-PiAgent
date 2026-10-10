// 嵌套工具卡（F18）：codemode 等工具经 ctx.executeTool() 发起的调用以**独立事件**到达
// （toolCallId 形如 <父id>/N，带 parentToolCallId），必须归并到父卡下渲染，
// 否则聊天区会出现两张平级卡片，用户看不出「这是脚本里调的一个工具」。
// 平铺调用（无 parentToolCallId）的渲染路径必须与改造前完全一致（回归保护）。
import { test, expect, describe, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { createElement, Fragment } from "react";
import type { SessionMessage, ToolResultMessage } from "@wa-pi/shared";

// MessageList 经 Virtuoso 渲染：本文件断言卡片结构而非虚拟化定位，用全量渲染的简化实现。
mock.module("react-virtuoso", () => ({
	Virtuoso: (props: any) => {
		const { data, itemContent, computeItemKey } = props;
		return createElement(
			"div",
			{ "data-testid": "message-list" },
			data.map((vr: any, i: number) =>
				createElement(
					Fragment,
					{ key: computeItemKey ? computeItemKey(i, vr) : i },
					itemContent(i, vr),
				),
			),
		);
	},
	VirtuosoMockContext: { Provider: ({ children }: any) => children },
}));

// 渲染层不会主动发请求，但 MessageList/store 会 import api-client；
// happy-dom 在 about:blank 下对相对 URL 抛错，mock 成空实现更稳（同 MessageList.test.tsx）。
mock.module("../src/api-client", () => ({
	api: {
		get: () => Promise.resolve(null),
		post: () => Promise.resolve({}),
		put: () => Promise.resolve({}),
		del: () => Promise.resolve({}),
	},
}));

import { MessageList } from "../src/components/MessageList";
import { VirtuosoMockContext } from "react-virtuoso";
import {
	ToolCallNested,
	ToolCallsSegment,
	groupToolCalls,
	persistedNestedCalls,
} from "../src/components/blocks/ToolCallNested";
import { useSessionStore } from "../src/store/session";
import { useUiPrefsStore } from "../src/store/ui-prefs";

// 基线：回复过程展开（卡片体可见）——本文件断言卡片内部结构；
// 「父卡折叠时子卡仍可见」这一条由用例内自行把开关置回去验证。
beforeEach(() => {
	useUiPrefsStore.setState({ collapseProcessByDefault: false });
	useSessionStore.setState({
		messagesBySession: {},
		streamingBySession: {},
		statusBySession: {},
		nestedCallsBySession: {},
	});
});

// ── POC 实测的事件/消息形状（F18，勿改）──

const outer = {
	toolCallId: "call_00_abc",
	toolName: "codemode",
	args: { code: 'const r = await tools.mcp__poc__echo({text:"hi"});' },
};
const inner = {
	toolCallId: "call_00_abc/1",
	toolName: "mcp__poc__echo",
	args: { text: "hi" },
	parentToolCallId: "call_00_abc",
};

function envelope(event: any, sessionId = "s1"): any {
	return { type: "sdk:event", sessionId, agentName: "product", event };
}

describe("groupToolCalls", () => {
	test("带 parentToolCallId 的调用归并到父卡下", () => {
		const groups = groupToolCalls([outer, inner]);
		expect(groups).toHaveLength(1);
		expect(groups[0].parent.toolCallId).toBe("call_00_abc");
		expect(groups[0].children.map((c) => c.toolCallId)).toEqual(["call_00_abc/1"]);
	});

	test("平铺调用保持原样（不回归）", () => {
		const groups = groupToolCalls([
			{ toolCallId: "x", toolName: "read", args: {} },
			{ toolCallId: "y", toolName: "bash", args: {} },
		]);
		expect(groups.map((g) => g.parent.toolCallId)).toEqual(["x", "y"]);
		expect(groups.every((g) => g.children.length === 0)).toBe(true);
	});

	test("只有持久化记录（无 parentToolCallId）时按 <父id>/N 前缀兜底归并", () => {
		const groups = groupToolCalls([
			outer,
			{ toolCallId: "call_00_abc/2", toolName: "mcp__poc__list", args: {} },
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0].children.map((c) => c.toolCallId)).toEqual(["call_00_abc/2"]);
	});

	test("父调用不在本段（父卡未渲染）时子调用不丢失：按根平铺渲染", () => {
		const groups = groupToolCalls([
			{ toolCallId: "call_00_abc/1", toolName: "mcp__poc__echo", args: {} },
		]);
		expect(groups.map((g) => g.parent.toolCallId)).toEqual(["call_00_abc/1"]);
	});
});

describe("persistedNestedCalls（历史会话：父工具结果的 nestedCalls 记录）", () => {
	// 真实形状 = pi `NestedCallRecorder.snapshot()` 的返回值（见 pi-ai 的 NestedToolCalls）：
	// **对象** `{ calls, complete }`，不是数组；agent-session 把整个对象写到 tool result 上。
	// 字段名也按 snapshot：`id` / `name` / `arguments`（对象）/ `status`(ok|error|unfinished)。
	const snapshot = {
		calls: [
			{ id: "call_00_abc/1", name: "mcp__poc__echo", arguments: { text: "hi" }, status: "ok" as const, durationMs: 5 },
			{ id: "call_00_abc/2", name: "mcp__poc__fail", status: "error" as const, error: "boom" },
			{ id: "call_00_abc/3", name: "mcp__poc__slow", status: "unfinished" as const },
		],
		complete: false,
	};

	test("按真实形状 {calls, complete} 解析 id/name/arguments/status", () => {
		const views = persistedNestedCalls({ nestedCalls: snapshot });
		expect(views.map((v) => v.toolCallId)).toEqual([
			"call_00_abc/1",
			"call_00_abc/2",
			"call_00_abc/3",
		]);
		expect(views.map((v) => v.toolName)).toEqual([
			"mcp__poc__echo",
			"mcp__poc__fail",
			"mcp__poc__slow",
		]);
		// arguments 是持久化记录里的对象（区别于 codemode details.calls 的 JSON 字符串）
		expect(views[0].args).toEqual({ text: "hi" });
		expect(views[0].status).toBe("ok");
		expect(views[1].status).toBe("error");
		// unfinished = 调用方工具结束时该调用还没跑完：中性终态，不得显示成「进行中」
		expect(views[2].status).toBe("unfinished");
	});

	test("无记录 / 畸形记录不抛错，返回空表", () => {
		expect(persistedNestedCalls(undefined)).toEqual([]);
		expect(persistedNestedCalls({})).toEqual([]);
		// 会话文件可能被手改/损坏：类型只是编译期约束，运行时容错必须保留
		const corrupt = {
			nestedCalls: { calls: [null, 1, { name: "no-id" }], complete: false },
		} as unknown as Pick<ToolResultMessage, "nestedCalls">;
		expect(persistedNestedCalls(corrupt)).toEqual([]);
	});
});

describe("ToolCallNested", () => {
	test("渲染父卡与内层子卡，并显示脚本输出两段内容", () => {
		render(
			<ToolCallNested
				group={{
					parent: {
						...outer,
						result: {
							content: [
								{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
								{ type: "text", text: '{"content":[{"type":"text","text":"pong"}]}' },
							],
						},
					},
					children: [
						{
							...inner,
							result: {
								content: [{ type: "text", text: 'pong-poc:{"text":"hi"}' }],
								details: { server: "poc", tool: "echo" },
							},
						},
					],
				}}
			/>,
		);
		expect(screen.getByText(/codemode/)).toBeTruthy();
		expect(
			screen.getByTestId("toolcall-nested-item-call_00_abc/1").textContent,
		).toContain("mcp__poc__echo");
		expect(screen.getAllByText(/mcp__poc__echo/).length).toBeGreaterThan(0);
		// 结果无论长短默认折叠：子卡结果可能是几百行 JSON，只有点展开才显示
		expect(screen.queryByText(/pong-poc/)).toBeNull();
		// 展开入口在子卡头部行内（右对齐）：整行可点，行内含工具名与「结果」入口
		const toggle = screen.getByTestId("toolcall-nested-result-toggle-call_00_abc/1");
		expect(toggle.textContent).toContain("mcp__poc__echo");
		expect(toggle.textContent).toContain("结果");
		// 入口顺序：「结果」文字在前、箭头 icon 在后（结果 ›）
		const entry = toggle.lastElementChild as HTMLElement;
		expect(entry.textContent).toContain("结果");
		expect(entry.firstChild?.textContent).toBe("结果");
		expect(entry.querySelector("svg")).toBeTruthy();
		// 点击行内任意位置（如工具名）也触发展开；再点收起：重新隐藏
		fireEvent.click(toggle.querySelector("span")!);
		expect(screen.getByText(/pong-poc/)).toBeTruthy();
		fireEvent.click(screen.getByTestId("toolcall-nested-result-toggle-call_00_abc/1"));
		expect(screen.queryByText(/pong-poc/)).toBeNull();
		// 展开父卡：codemode 结果的两段文本（“Script completed…” + 脚本输出）分别成块渲染，不糊成一坨
		fireEvent.click(screen.getByTestId("toolcall-call_00_abc-header"));
		const parentBody = screen.getByTestId("toolcall-call_00_abc-body");
		const resultBlocks = Array.from(parentBody.querySelectorAll("div")).filter(
			(d) =>
				d.textContent?.startsWith("Script completed") ||
				d.textContent?.startsWith('{"content"'),
		);
		// 排除包住两段的结果容器本身，只数真正的文本块
		expect(resultBlocks.filter((d) => !d.querySelector("div"))).toHaveLength(2);
	});

	test("子卡挂在外层卡之后，且父卡折叠（生产默认）时仍可见", () => {
		useUiPrefsStore.setState({ collapseProcessByDefault: true });
		render(
			<ToolCallNested
				group={{
					parent: { ...outer, result: { content: [{ type: "text", text: "Script completed" }] } },
					children: [{ ...inner, status: "ok", result: { content: [{ type: "text", text: "pong" }] } }],
				}}
			/>,
		);
		const wrapper = screen.getByTestId("toolcall-nested-call_00_abc");
		const parentCard = screen.getByTestId("toolcall-call_00_abc");
		const childCard = screen.getByTestId("toolcall-nested-item-call_00_abc/1");
		expect(wrapper.contains(parentCard)).toBe(true);
		expect(wrapper.contains(childCard)).toBe(true);
		// 子卡在父卡折叠体之外：生产默认折叠下，父卡的参数/结果隐藏，
		// 而「脚本调了哪些工具」的答案（子卡）仍一眼可见
		expect(screen.queryByTestId("toolcall-call_00_abc-body")).toBeNull();
		expect(parentCard.contains(childCard)).toBe(false);
		// 子卡可见（「脚本调了哪些工具」一眼可见），但结果默认折叠：只留展开入口，不显示结果文本
		expect(screen.queryByText("pong")).toBeNull();
		expect(screen.getByTestId("toolcall-nested-result-toggle-call_00_abc/1")).toBeTruthy();
	});

	test("子卡无结果（running）时不渲染结果展开入口", () => {
		render(
			<ToolCallNested
				group={{
					parent: outer,
					children: [
						{ toolCallId: "call_00_abc/2", toolName: "mcp__poc__slow", args: {}, status: "running", parentToolCallId: "call_00_abc" },
					],
				}}
				isStreaming
			/>,
		);
		expect(screen.getByTestId("toolcall-nested-item-call_00_abc/2")).toBeTruthy();
		expect(screen.queryByTestId("toolcall-nested-result-toggle-call_00_abc/2")).toBeNull();
	});

	test("内层调用失败 → 子卡带失败标记；未完成 → 不误报成功", () => {
		render(
			<ToolCallNested
				group={{
					parent: outer,
					children: [
						{ toolCallId: "call_00_abc/1", toolName: "mcp__poc__bad", args: {}, status: "error", result: { content: [{ type: "text", text: "boom" }] } },
						{ toolCallId: "call_00_abc/2", toolName: "mcp__poc__slow", args: {}, status: "running", parentToolCallId: "call_00_abc" },
					],
				}}
				isStreaming
			/>,
		);
		expect(screen.getByTestId("toolcall-nested-item-call_00_abc/1").getAttribute("data-status")).toBe("error");
		expect(screen.getByTestId("toolcall-nested-item-call_00_abc/2").getAttribute("data-status")).toBe("running");
	});

	test("历史遗留的 unfinished 是中性终态：不打转圈（历史会话里它早已结束）", () => {
		render(
			<ToolCallNested
				group={{
					parent: outer,
					children: [
						{ toolCallId: "call_00_abc/1", toolName: "mcp__poc__slow", args: {}, status: "unfinished", parentToolCallId: "call_00_abc" },
						{ toolCallId: "call_00_abc/2", toolName: "mcp__poc__live", args: {}, status: "running", parentToolCallId: "call_00_abc" },
					],
				}}
			/>,
		);
		const stale = screen.getByTestId("toolcall-nested-item-call_00_abc/1");
		expect(stale.getAttribute("data-status")).toBe("unfinished");
		expect(stale.querySelector('[style*="spin"]')).toBeNull();
		// 对照组：真正进行中的调用仍有转圈
		expect(
			screen.getByTestId("toolcall-nested-item-call_00_abc/2").querySelector('[style*="spin"]'),
		).not.toBeNull();
	});
});

describe("store：嵌套调用采集（tool_execution_* 事件，带 parentToolCallId）", () => {
	test("按父 id 归并，字段/结果齐全（parentToolCallId 确实到达前端）", () => {
		const s = useSessionStore.getState();
		s.handleSDKEvent(
			"s1",
			envelope({
				type: "tool_execution_start",
				toolCallId: "call_00_abc/1",
				toolName: "mcp__poc__echo",
				args: { text: "hi" },
				parentToolCallId: "call_00_abc",
			}),
		);
		s.handleSDKEvent(
			"s1",
			envelope({
				type: "tool_execution_end",
				toolCallId: "call_00_abc/1",
				toolName: "mcp__poc__echo",
				isError: false,
				result: {
					content: [{ type: "text", text: 'pong-poc:{"text":"hi"}' }],
					details: { server: "poc", tool: "echo" },
				},
				parentToolCallId: "call_00_abc",
			}),
		);

		const list = useSessionStore.getState().nestedCallsBySession.s1["call_00_abc"];
		expect(list).toHaveLength(1);
		expect(list[0].toolCallId).toBe("call_00_abc/1");
		expect(list[0].toolName).toBe("mcp__poc__echo");
		expect(list[0].parentToolCallId).toBe("call_00_abc");
		expect(list[0].args).toEqual({ text: "hi" });
		expect(list[0].status).toBe("ok");
		expect(list[0].result?.content?.[0]?.text).toBe('pong-poc:{"text":"hi"}');
	});

	test("子卡先 end（父卡还在跑）：先落结果，父卡 end 后仍挂在该父 id 下", () => {
		const s = useSessionStore.getState();
		s.handleSDKEvent(
			"s1",
			envelope({
				type: "tool_execution_start",
				toolCallId: "call_00_abc/1",
				toolName: "mcp__poc__echo",
				args: { text: "hi" },
				parentToolCallId: "call_00_abc",
			}),
		);
		s.handleSDKEvent(
			"s1",
			envelope({
				type: "tool_execution_end",
				toolCallId: "call_00_abc/1",
				toolName: "mcp__poc__echo",
				isError: false,
				result: { content: [{ type: "text", text: "pong" }] },
				parentToolCallId: "call_00_abc",
			}),
		);
		// 父卡（codemode）此时还没 end —— 不得因此错位/丢失
		s.handleSDKEvent(
			"s1",
			envelope({
				type: "tool_execution_end",
				toolCallId: "call_00_abc",
				toolName: "codemode",
				isError: false,
				result: { content: [{ type: "text", text: "Script completed" }] },
			}),
		);
		const byParent = useSessionStore.getState().nestedCallsBySession.s1;
		expect(Object.keys(byParent)).toEqual(["call_00_abc"]);
		expect(byParent["call_00_abc"][0].status).toBe("ok");
	});

	test("平铺调用（无 parentToolCallId）不进嵌套表", () => {
		const s = useSessionStore.getState();
		s.handleSDKEvent(
			"s1",
			envelope({
				type: "tool_execution_start",
				toolCallId: "call_flat",
				toolName: "read",
				args: { path: "a.ts" },
			}),
		);
		s.handleSDKEvent(
			"s1",
			envelope({
				type: "tool_execution_end",
				toolCallId: "call_flat",
				toolName: "read",
				isError: false,
				result: { content: [{ type: "text", text: "x" }] },
			}),
		);
		expect(useSessionStore.getState().nestedCallsBySession.s1).toBeUndefined();
	});

	test("removeSession 清理该会话的嵌套调用表", () => {
		const s = useSessionStore.getState();
		s.handleSDKEvent(
			"s1",
			envelope({
				type: "tool_execution_start",
				toolCallId: "call_00_abc/1",
				toolName: "mcp__poc__echo",
				args: {},
				parentToolCallId: "call_00_abc",
			}),
		);
		expect(useSessionStore.getState().nestedCallsBySession.s1).toBeTruthy();
		useSessionStore.getState().removeSession("s1");
		expect(useSessionStore.getState().nestedCallsBySession.s1).toBeUndefined();
	});
});

describe("ToolCallsSegment：平铺调用不回归", () => {
	const readCall = {
		type: "toolCall" as const,
		id: "t1",
		name: "read",
		arguments: { path: "a.ts" },
	};
	const readResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "t1",
		toolName: "read",
		content: [{ type: "text", text: "file body" }],
		isError: false,
		timestamp: 0,
	};

	test("单调用：与既有 ToolCallCard 同款（无嵌套容器）", () => {
		render(
			<ToolCallsSegment
				sessionId="s1"
				toolCalls={[readCall]}
				results={new Map([["t1", readResult]])}
			/>,
		);
		expect(screen.getByTestId("toolcall-t1")).toBeTruthy();
		expect(screen.queryByTestId("toolcall-nested-t1")).toBeNull();
		expect(screen.queryByTestId("toolcall-group")).toBeNull();
	});

	test("多调用：仍是既有的组卡（不再逐张平铺，也无嵌套容器）", () => {
		render(
			<ToolCallsSegment
				sessionId="s1"
				toolCalls={[
					readCall,
					{ type: "toolCall" as const, id: "t2", name: "bash", arguments: { command: "ls" } },
				]}
				results={new Map([["t1", readResult]])}
			/>,
		);
		expect(screen.getByTestId("toolcall-group")).toBeTruthy();
		expect(screen.getByTestId("toolcall-t1")).toBeTruthy();
		expect(screen.getByTestId("toolcall-t2")).toBeTruthy();
		expect(screen.queryByTestId("toolcall-nested-t1")).toBeNull();
	});

	test("edit 结果详情（details.diff）仍驱动 +N -M 统计", () => {
		render(
			<ToolCallsSegment
				sessionId="s1"
				toolCalls={[
					{
						type: "toolCall" as const,
						id: "e1",
						name: "edit",
						arguments: { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] },
					},
				]}
				results={
					new Map([
						[
							"e1",
							{
								...readResult,
								toolCallId: "e1",
								toolName: "edit",
								details: { diff: "+1 b\n-2 a" },
							} as ToolResultMessage,
						],
					])
				}
			/>,
		);
		const stats = screen.getByTestId("toolcall-e1-stats");
		expect(stats.textContent).toContain("+1");
		expect(stats.textContent).toContain("-1");
	});
});

describe("ToolCallsSegment：历史会话嵌套（仅持久化记录，无实时事件）", () => {
	// 重开旧会话时的唯一来源：内层调用不进 transcript，store 的实时表也是空的
	const codemodeResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call_00_abc",
		toolName: "codemode",
		content: [{ type: "text", text: "Script completed" }],
		isError: false,
		timestamp: 0,
		nestedCalls: {
			calls: [
				{ id: "call_00_abc/1", name: "mcp__poc__echo", arguments: { text: "hi" }, status: "ok" },
				{ id: "call_00_abc/2", name: "mcp__poc__slow", status: "unfinished" },
			],
			complete: false,
		},
	};

	test("真实形状 {calls, complete} → 渲染出子卡（含参数摘要）", () => {
		render(
			<ToolCallsSegment
				sessionId="s1"
				toolCalls={[
					{ type: "toolCall" as const, id: "call_00_abc", name: "codemode", arguments: outer.args },
				]}
				results={new Map([["call_00_abc", codemodeResult]])}
			/>,
		);
		const child = screen.getByTestId("toolcall-nested-item-call_00_abc/1");
		expect(child.textContent).toContain("mcp__poc__echo");
		expect(child.textContent).toContain('"hi"');
		expect(child.getAttribute("data-status")).toBe("ok");
		// 不再出现平级的第二张卡片
		expect(screen.queryByTestId("toolcall-call_00_abc/1")).toBeNull();
	});

	test("记录里的 unfinished → 中性终态，不打转圈", () => {
		render(
			<ToolCallsSegment
				sessionId="s1"
				toolCalls={[
					{ type: "toolCall" as const, id: "call_00_abc", name: "codemode", arguments: outer.args },
				]}
				results={new Map([["call_00_abc", codemodeResult]])}
			/>,
		);
		const stale = screen.getByTestId("toolcall-nested-item-call_00_abc/2");
		expect(stale.getAttribute("data-status")).toBe("unfinished");
		expect(stale.querySelector('[style*="spin"]')).toBeNull();
	});
});

// ── MessageList 端到端（组件层）：事件流 → 聊天区嵌套卡片 ──

function assistantMsg(timestamp: number, content: any[]): SessionMessage {
	return {
		agentName: "product",
		message: {
			role: "assistant",
			content,
			model: "pi-test",
			stopReason: "end_turn",
			timestamp,
		},
	} as SessionMessage;
}

function toolResultMsg(over: Partial<ToolResultMessage>): SessionMessage {
	return {
		agentName: "product",
		message: {
			role: "toolResult",
			toolCallId: "call_00_abc",
			toolName: "codemode",
			content: [{ type: "text", text: "Script completed" }],
			isError: false,
			timestamp: 2,
			...over,
		},
	} as SessionMessage;
}

function renderList() {
	return render(
		<VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 60 }}>
			<MessageList sessionId="s1" />
		</VirtuosoMockContext.Provider>,
	);
}

describe("MessageList：codemode → MCP 嵌套卡", () => {
	test("内层 MCP 调用渲染为父卡下的缩进子卡（结果可见）", () => {
		const s = useSessionStore.getState();
		// 事件流（POC 实测形状）：外层 codemode + 内层 mcp__poc__echo
		s.handleSDKEvent(
			"s1",
			envelope({ type: "tool_execution_start", toolCallId: "call_00_abc", toolName: "codemode", args: outer.args }),
		);
		s.handleSDKEvent(
			"s1",
			envelope({
				type: "tool_execution_start",
				toolCallId: "call_00_abc/1",
				toolName: "mcp__poc__echo",
				args: { text: "hi" },
				parentToolCallId: "call_00_abc",
			}),
		);
		s.handleSDKEvent(
			"s1",
			envelope({
				type: "tool_execution_end",
				toolCallId: "call_00_abc/1",
				toolName: "mcp__poc__echo",
				isError: false,
				result: { content: [{ type: "text", text: 'pong-poc:{"text":"hi"}' }], details: { server: "poc", tool: "echo" } },
				parentToolCallId: "call_00_abc",
			}),
		);
		useSessionStore.setState({
			messagesBySession: {
				s1: [
					assistantMsg(1, [
						{ type: "text", text: "让我调一下工具" },
						{
							type: "toolCall",
							id: "call_00_abc",
							name: "codemode",
							arguments: outer.args,
						},
					]),
					toolResultMsg({}),
				],
			},
		});

		renderList();
		// 整轮已结束 → 过程段折叠在轮级摘要行内，先展开
		fireEvent.click(screen.getByTestId("turn-summary"));
		const wrapper = screen.getByTestId("toolcall-nested-call_00_abc");
		expect(wrapper.textContent).toContain("mcp__poc__echo");
		// 子卡结果默认折叠：不直接显示，点子卡展开入口后才见全文
		expect(wrapper.textContent).not.toContain('pong-poc:{"text":"hi"}');
		fireEvent.click(screen.getByTestId("toolcall-nested-result-toggle-call_00_abc/1"));
		expect(wrapper.textContent).toContain('pong-poc:{"text":"hi"}');
		// 平级两张卡的问题已消除：只有一张 codemode 父卡 + 其下子卡
		expect(screen.getAllByTestId(/^toolcall-call_00_abc$/)).toHaveLength(1);
		expect(screen.queryByTestId("toolcall-call_00_abc/1")).toBeNull();
	});

	test("平铺工具调用：渲染与既有一致（单卡，无嵌套容器）", () => {
		useSessionStore.setState({
			messagesBySession: {
				s1: [
					assistantMsg(1, [
						{ type: "toolCall", id: "call_flat", name: "read", arguments: { path: "a.ts" } },
					]),
					toolResultMsg({
						toolCallId: "call_flat",
						toolName: "read",
						content: [{ type: "text", text: "file body" }],
					}),
				],
			},
		});
		renderList();
		fireEvent.click(screen.getByTestId("turn-summary"));
		expect(screen.getByTestId("toolcall-call_flat")).toBeTruthy();
		expect(screen.queryByTestId("toolcall-nested-call_flat")).toBeNull();
	});

	test("历史会话：父工具结果的 nestedCalls 记录（真实形状 {calls, complete}）渲染为子卡", () => {
		useSessionStore.setState({
			messagesBySession: {
				s1: [
					assistantMsg(1, [
						{
							type: "toolCall",
							id: "call_00_abc",
							name: "codemode",
							arguments: outer.args,
						},
					]),
					toolResultMsg({
						// pi 落盘的真实形状：对象 { calls, complete }（不是数组）
						nestedCalls: {
							calls: [
								{ id: "call_00_abc/1", name: "mcp__poc__echo", arguments: { text: "hi" }, status: "ok" },
							],
							complete: true,
						},
					}),
				],
			},
		});
		renderList();
		fireEvent.click(screen.getByTestId("turn-summary"));
		expect(
			screen.getByTestId("toolcall-nested-item-call_00_abc/1").textContent,
		).toContain("mcp__poc__echo");
	});
});
