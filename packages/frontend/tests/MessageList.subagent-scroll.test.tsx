// 子代理运行期间自动滚动测试。
// 复刻 bug：virtuoso 改造后移除了每帧贴底 rAF 循环，子代理 progress 增长不改变
// listRows.length，强制滚动 effect 不触发。修复方案：autoScrollActive && stickBottom
// 时 200ms interval 定期 scrollToIndex 到末行。
//
// mock react-virtuoso 捕获 scrollToIndex 调用（同 enter-scroll.test.tsx 模式）。
import { test, expect, mock, beforeEach } from "bun:test";
import { render, waitFor, fireEvent } from "@testing-library/react";

const scrollToIndexCalls: any[] = [];
// mock Virtuoso 捕获 scrollerRef 回调，供测试模拟原生 scroll（滚动条/键盘等非 wheel/touch 路径）
let mockScrollerEl: HTMLElement | null = null;
mock.module("react-virtuoso", () => {
	const { forwardRef, useImperativeHandle, createElement } = require("react");
	const Virtuoso = forwardRef(function MockVirtuoso(props: any, ref: any) {
		useImperativeHandle(
			ref,
			() => ({
				scrollToIndex: (opts: any) => scrollToIndexCalls.push(opts),
			}),
			[],
		);
		const data = props.data ?? [];
		// 模拟 Virtuoso 的 scrollerRef 回调：把渲染的滚动容器交给宿主监听原生 scroll
		const scrollerRef = (el: HTMLElement | null) => {
			mockScrollerEl = el;
			props.scrollerRef?.(el);
		};
		return createElement(
			"div",
			{ "data-testid": "message-list", ref: scrollerRef },
			data.map((item: any, i: number) => props.itemContent(i, item)),
		);
	});
	return { Virtuoso };
});

mock.module("../src/api-client", () => ({
	api: {
		get: () => Promise.resolve(null),
		post: () => Promise.resolve({}),
		put: () => Promise.resolve({}),
		del: () => Promise.resolve({}),
	},
}));

import type { SessionMessage } from "@wa-pi/shared";
import { MessageList } from "../src/components/MessageList";
import { useSessionStore } from "../src/store/session";
import { useProjectsStore } from "../src/store/projects";
import { useProvidersStore } from "../src/store/providers";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { useToastStore } from "../src/store/toast";

function userMsg(ts: number, text: string): SessionMessage {
	return {
		agentName: undefined,
		message: { role: "user", content: text, timestamp: ts },
	} as SessionMessage;
}
function assistantMsg(ts: number, text: string): SessionMessage {
	return {
		agentName: "dev",
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			model: "m",
			stopReason: "end_turn",
			timestamp: ts,
		},
	} as SessionMessage;
}

beforeEach(() => {
	scrollToIndexCalls.length = 0;
	mockScrollerEl = null;
	useSessionStore.setState({
		messagesBySession: {},
		streamingBySession: {},
		statusBySession: {},
		progressByToolCall: {},
		progressSessionByToolCall: {},
		netStatusBySession: {},
	});
	useProjectsStore.setState({ sessions: [] });
	useProvidersStore.setState({ providers: [] });
	useComposerPrefsStore.setState({ bySession: {} });
	useToastStore.setState({ toasts: [] });
});

test("子代理运行中时定期 scrollToIndex 到末行（interval 贴底）", async () => {
	useSessionStore.setState({
		messagesBySession: {
			s1: [userMsg(1, "帮我查一下"), assistantMsg(2, "好的，委派子代理")],
		},
		statusBySession: { s1: "thinking" },
		progressByToolCall: {
			tc1: {
				Explore: {
					agent: "Explore",
					status: "running",
					output: "正在搜索...",
					tools: [],
					elapsedMs: 1000,
				},
			},
		},
		progressSessionByToolCall: { tc1: "s1" },
	});

	render(<MessageList sessionId="s1" />);

	// 等待初始 effect（进入会话 + 强制贴底）滚动完成
	await waitFor(() => expect(scrollToIndexCalls.length).toBeGreaterThan(0));
	const initialCount = scrollToIndexCalls.length;

	// 等 600ms：interval（200ms）应至少触发 2 次额外的 scrollToIndex
	await new Promise((r) => setTimeout(r, 600));
	expect(scrollToIndexCalls.length).toBeGreaterThan(initialCount);

	// 最后一次调用的 index 应为末行（index=1，共 2 行消息）
	const last = scrollToIndexCalls[scrollToIndexCalls.length - 1];
	expect(last.index).toBe(1);
	expect(last.align).toBe("end");
});

test("子代理完成后 autoScrollActive 变 false → interval 停止", async () => {
	useSessionStore.setState({
		messagesBySession: {
			s1: [userMsg(1, "帮我查一下"), assistantMsg(2, "好的")],
		},
		statusBySession: { s1: "idle" },
		progressByToolCall: {},
		progressSessionByToolCall: {},
	});

	render(<MessageList sessionId="s1" />);

	// 等待初始 effect 滚动完成
	await waitFor(() => expect(scrollToIndexCalls.length).toBeGreaterThan(0));
	const countAfterInit = scrollToIndexCalls.length;

	// 等 500ms 确认无 interval 持续触发（autoScrollActive=false）
	await new Promise((r) => setTimeout(r, 500));
	expect(scrollToIndexCalls.length).toBe(countAfterInit);
});

// 用户手动上翻（wheel 向上滚动）→ 即使 autoScrollActive=true（AI 回复中）也必须停止自动滚动。
// 回归：67760b5 的 atBottomStateChange 守卫在 autoScrollActive 期间不置 stickBottom=false，
// 且 200ms interval 持续强制 scrollToIndex 到底部——用户手动滚动被无视，一直拉回底部。
// 修复：监听用户 wheel/touch 输入，向上翻阅时无条件置 stickBottom=false（interval 随之停止）。
test("用户手动上翻（wheel 向上）后 interval 停止强制滚动到底部", async () => {
	useSessionStore.setState({
		messagesBySession: {
			s1: [userMsg(1, "帮我查一下"), assistantMsg(2, "好的，委派子代理")],
		},
		statusBySession: { s1: "thinking" },
		progressByToolCall: {
			tc1: {
				Explore: {
					agent: "Explore",
					status: "running",
					output: "正在搜索...",
					tools: [],
					elapsedMs: 1000,
				},
			},
		},
		progressSessionByToolCall: { tc1: "s1" },
	});

	render(<MessageList sessionId="s1" />);

	// 等待 interval 已开始强制滚动（scrollToIndexCalls 增长中）
	await waitFor(() => expect(scrollToIndexCalls.length).toBeGreaterThan(0));
	await new Promise((r) => setTimeout(r, 250));
	const countBeforeScroll = scrollToIndexCalls.length;
	expect(countBeforeScroll).toBeGreaterThan(0);

	// 模拟用户滚轮向上（翻阅历史）：真实浏览器中 wheel 上翻会改变 scrollTop 并
	// 派发原生 scroll 事件（实现统一监听原生 scroll，不直接监听 wheel）。
	// 先让 scroller 处于底部，再 wheel 上翻到中部。
	expect(mockScrollerEl).not.toBeNull();
	Object.defineProperty(mockScrollerEl!, "scrollTop", {
		value: 1600,
		writable: true,
	});
	Object.defineProperty(mockScrollerEl!, "scrollHeight", {
		value: 2000,
		writable: true,
	});
	Object.defineProperty(mockScrollerEl!, "clientHeight", {
		value: 400,
		writable: true,
	});
	// 贴底状态（不触发停止）
	mockScrollerEl!.dispatchEvent(new Event("scroll", { bubbles: true }));
	// wheel 上翻 → scrollTop 减小 → 原生 scroll 事件
	Object.defineProperty(mockScrollerEl!, "scrollTop", {
		value: 500,
		writable: true,
	});
	mockScrollerEl!.dispatchEvent(new Event("scroll", { bubbles: true }));

	// 等 600ms：若修复生效，interval 已停止，scrollToIndexCalls 不再增长
	await new Promise((r) => setTimeout(r, 600));
	expect(scrollToIndexCalls.length).toBe(countBeforeScroll);
});

// 滚动条拖动 / 键盘 PageUp 等非 wheel/touch 输入路径：只产生原生 scroll 事件。
// 修复前这些路径同样被 67760b5 守卫忽略（autoScrollActive 期间不置 stickBottom=false），
// interval 持续拉回底部。修复后原生 scroll 监听兜底所有用户滚动路径。
test("用户拖滚动条（原生 scroll，非 wheel/touch）后 interval 停止强制滚动到底部", async () => {
	useSessionStore.setState({
		messagesBySession: {
			s1: [userMsg(1, "帮我查一下"), assistantMsg(2, "好的，委派子代理")],
		},
		statusBySession: { s1: "thinking" },
		progressByToolCall: {
			tc1: {
				Explore: {
					agent: "Explore",
					status: "running",
					output: "正在搜索...",
					tools: [],
					elapsedMs: 1000,
				},
			},
		},
		progressSessionByToolCall: { tc1: "s1" },
	});

	render(<MessageList sessionId="s1" />);

	// 等待 interval 已开始强制滚动
	await waitFor(() => expect(scrollToIndexCalls.length).toBeGreaterThan(0));
	await new Promise((r) => setTimeout(r, 250));
	const countBeforeScroll = scrollToIndexCalls.length;
	expect(countBeforeScroll).toBeGreaterThan(0);

	// 模拟用户拖滚动条：真实时序是「进入时在底部 → 用户向上拖离底」。
	// 先让 scroller 处于底部（scrollTop=1600），再模拟用户上翻到中部（scrollTop=500），
	// 两次都派发原生 scroll 事件（Virtuoso 的 scrollerRef 已把滚动容器交给 MessageList 监听）。
	expect(mockScrollerEl).not.toBeNull();
	Object.defineProperty(mockScrollerEl!, "scrollTop", {
		value: 1600,
		writable: true,
	});
	Object.defineProperty(mockScrollerEl!, "scrollHeight", {
		value: 2000,
		writable: true,
	});
	Object.defineProperty(mockScrollerEl!, "clientHeight", {
		value: 400,
		writable: true,
	});
	// 第一次：模拟程序化贴底后的状态（scrollTop 增大，不触发停止）
	mockScrollerEl!.dispatchEvent(new Event("scroll", { bubbles: true }));
	// 第二次：用户向上拖滚动条（scrollTop 减小 → 翻阅历史 → 停止跟随）
	Object.defineProperty(mockScrollerEl!, "scrollTop", {
		value: 500,
		writable: true,
	});
	mockScrollerEl!.dispatchEvent(new Event("scroll", { bubbles: true }));

	// 等 600ms：若修复生效，interval 已停止
	await new Promise((r) => setTimeout(r, 600));
	expect(scrollToIndexCalls.length).toBe(countBeforeScroll);
});

// 反向防护：程序化贴底（scrollTop 增大）不得误停 interval。
// 若实现把「scrollTop 增大」也当作停止信号，本用例会捕获回归
// （interval 应继续滚动，scrollToIndexCalls 持续增长）。
test("程序化贴底（scrollTop 增大）不误停 interval：自动滚动继续", async () => {
	useSessionStore.setState({
		messagesBySession: {
			s1: [userMsg(1, "帮我查一下"), assistantMsg(2, "好的，委派子代理")],
		},
		statusBySession: { s1: "thinking" },
		progressByToolCall: {
			tc1: {
				Explore: {
					agent: "Explore",
					status: "running",
					output: "正在搜索...",
					tools: [],
					elapsedMs: 1000,
				},
			},
		},
		progressSessionByToolCall: { tc1: "s1" },
	});

	render(<MessageList sessionId="s1" />);

	// 等待 interval 已开始强制滚动
	await waitFor(() => expect(scrollToIndexCalls.length).toBeGreaterThan(0));
	await new Promise((r) => setTimeout(r, 250));
	const countBeforeScroll = scrollToIndexCalls.length;
	expect(countBeforeScroll).toBeGreaterThan(0);

	// 模拟程序化贴底：scrollTop 增大（0 → 1600），派发原生 scroll 事件
	expect(mockScrollerEl).not.toBeNull();
	Object.defineProperty(mockScrollerEl!, "scrollTop", {
		value: 1600,
		writable: true,
	});
	Object.defineProperty(mockScrollerEl!, "scrollHeight", {
		value: 2000,
		writable: true,
	});
	Object.defineProperty(mockScrollerEl!, "clientHeight", {
		value: 400,
		writable: true,
	});
	mockScrollerEl!.dispatchEvent(new Event("scroll", { bubbles: true }));

	// 等 600ms：interval 应继续滚动（scrollToIndexCalls 增长）
	await new Promise((r) => setTimeout(r, 600));
	expect(scrollToIndexCalls.length).toBeGreaterThan(countBeforeScroll);
});

// ============================================================================
// 发送消息恢复贴底跟随——回归守护（bug：发送消息不自动滚到底）
// 背景：进入会话定位到底存在竞态（scrollToEnd 与 Virtuoso 数据就绪竞争）——偶发定位
// 失败后视口停在中部/顶部，atBottomStateChange(false) 把 stickBottom 置 false；此后用户
// 发送新消息，三条自动滚动路径（强制贴底 effect / 200ms interval / followOutput）全部
// 依赖 stickBottom=true → 全部失效 → 新消息在视口外。修复：新 user 消息到达（发送/回声）
// → 恢复 stickBottom=true（发送是明确的「回到最新」意图，标准 IM 行为）。
// ============================================================================

// 复刻进入会话定位失败后的状态：视口不在底部（stickBottom=false）。
// 用原生 scroll 事件（scrollTop 减小）置 stickBottom=false——与 handleScrollerScroll 交互。
function forceStickBottomFalse() {
	expect(mockScrollerEl).not.toBeNull();
	Object.defineProperty(mockScrollerEl!, "scrollTop", { value: 1600, writable: true });
	Object.defineProperty(mockScrollerEl!, "scrollHeight", { value: 2000, writable: true });
	Object.defineProperty(mockScrollerEl!, "clientHeight", { value: 400, writable: true });
	// 程序化贴底（scrollTop 增大）——初始化 lastScrollTopRef
	mockScrollerEl!.dispatchEvent(new Event("scroll", { bubbles: true }));
	// 用户上翻（scrollTop 减小）→ stickBottom=false
	Object.defineProperty(mockScrollerEl!, "scrollTop", { value: 500, writable: true });
	mockScrollerEl!.dispatchEvent(new Event("scroll", { bubbles: true }));
}

test("stickBottom=false（用户不在底部）时发送新消息 → 应恢复贴底并滚动到底部", async () => {
	useSessionStore.setState({
		messagesBySession: { s1: [userMsg(1, "帮我查一下"), assistantMsg(2, "好的，委派子代理")] },
		statusBySession: { s1: "idle" },
	});
	render(<MessageList sessionId="s1" />);
	// 等初始进入会话滚动完成
	await waitFor(() => expect(scrollToIndexCalls.length).toBeGreaterThan(0));
	scrollToIndexCalls.length = 0;

	// 用户不在底部（模拟进入定位失败/用户上翻后的 stickBottom=false）
	forceStickBottomFalse();
	// 等 scroll 事件置 stickBottom=false 生效（浮钮逻辑）
	await new Promise((r) => setTimeout(r, 50));
	scrollToIndexCalls.length = 0;

	// 用户发送新消息（乐观置入 + thinking）
	useSessionStore.getState().optimisticSend("s1", "新问题", "dev");

	// 修复后：发送消息应恢复贴底 → scrollToIndex 被调用滚到末行
	await waitFor(() => {
		expect(scrollToIndexCalls.length).toBeGreaterThan(0);
	});
	const last = scrollToIndexCalls[scrollToIndexCalls.length - 1];
	expect(last.align).toBe("end");
});

test("回归防护：AI 回复中（无新 user 消息）用户上翻 → 不恢复贴底（319fd76b 语义保持）", async () => {
	useSessionStore.setState({
		messagesBySession: { s1: [userMsg(1, "帮我查一下"), assistantMsg(2, "好的")] },
		statusBySession: { s1: "thinking" },
		streamingBySession: {
			s1: {
				message: {
					role: "assistant",
					content: [{ type: "text", text: "正在回复" }],
					model: "pending",
					stopReason: "pending",
					timestamp: 999,
				},
				agentName: "dev",
			},
		},
	});
	render(<MessageList sessionId="s1" />);
	await waitFor(() => expect(scrollToIndexCalls.length).toBeGreaterThan(0));
	scrollToIndexCalls.length = 0;
	await new Promise((r) => setTimeout(r, 250)); // interval 已在跑

	// 用户上翻 → stickBottom=false → interval 停止
	forceStickBottomFalse();
	await new Promise((r) => setTimeout(r, 300));
	const afterUpScroll = scrollToIndexCalls.length;

	// 等 500ms：无新 user 消息 → 不应恢复滚动（interval 停止）
	await new Promise((r) => setTimeout(r, 500));
	expect(scrollToIndexCalls.length).toBe(afterUpScroll);
});
