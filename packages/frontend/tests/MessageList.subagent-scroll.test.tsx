// 子代理运行期间自动滚动测试。
// 复刻 bug：virtuoso 改造后移除了每帧贴底 rAF 循环，子代理 progress 增长不改变
// listRows.length，强制滚动 effect 不触发。修复方案：autoScrollActive && stickBottom
// 时 200ms interval 定期 scrollToIndex 到末行。
//
// mock react-virtuoso 捕获 scrollToIndex 调用（同 enter-scroll.test.tsx 模式）。
import { test, expect, mock, beforeEach } from "bun:test";
import { render, waitFor } from "@testing-library/react";

const scrollToIndexCalls: any[] = [];
// mock Virtuoso 捕获 scrollerRef 回调，供测试模拟原生 scroll（滚动条/键盘等非 wheel/touch 路径）
let mockScrollerEl: HTMLElement | null = null;
// 暴露 atBottomStateChange 供测试模拟「内容展开/折叠导致被动离底」（Virtuoso 数据变化后调用）
let mockAtBottomStateChange: ((atBottom: boolean) => void) | null = null;
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
		mockAtBottomStateChange = props.atBottomStateChange ?? null;
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
	mockAtBottomStateChange = null;
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
	// 用户滚轮输入（MessageList 监听 wheel 标记「用户滚动输入」）
	mockScrollerEl!.dispatchEvent(new Event("wheel", { bubbles: true }));
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
	// 用户按下滚动条（MessageList 监听 pointerdown 标记「用户滚动输入」）
	mockScrollerEl!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
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
	// 用户主动滚动输入（wheel）——修复后仅用户输入才置 stickBottom=false
	mockScrollerEl!.dispatchEvent(new Event("wheel", { bubbles: true }));
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
	// 程序化贴底（scrollTop 增大）——初始化 lastScrollTopRef
	mockScrollerEl!.dispatchEvent(new Event("scroll", { bubbles: true }));
	// 用户上翻（scrollTop 减小）→ stickBottom=false
	Object.defineProperty(mockScrollerEl!, "scrollTop", {
		value: 500,
		writable: true,
	});
	mockScrollerEl!.dispatchEvent(new Event("scroll", { bubbles: true }));
}

test("stickBottom=false（用户不在底部）时发送新消息 → 应恢复贴底并滚动到底部", async () => {
	useSessionStore.setState({
		messagesBySession: {
			s1: [userMsg(1, "帮我查一下"), assistantMsg(2, "好的，委派子代理")],
		},
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
		messagesBySession: {
			s1: [userMsg(1, "帮我查一下"), assistantMsg(2, "好的")],
		},
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

// ============================================================================
// 内容折叠/展开导致被动离底——不应误置 stickBottom（bug：贴底时反复出现浮钮）
// 背景：用户一直贴底（stickBottom=true）。对话中某行折叠（内容变短，浏览器被动
// clamp scrollTop 减小 → scroll 事件误判「用户上翻」）或展开（内容变长，
// maxScrollTop 增大 → Virtuoso 调 atBottomStateChange(false)）——用户没有主动滚动，
// 但 stickBottom 被误置 false → 浮钮反复出现，且后续自动滚动路径全部失效。
// 修复：区分「用户主动滚动输入」（wheel/touch/keyboard/滚动条拖动）与「内容高度
// 被动变化」——只有用户主动滚动才置 stickBottom=false；内容变化导致被动离底时
// 保持贴底并滚回底部。
// ============================================================================

// 模拟用户主动滚动输入（wheel）：触发 MessageList 的输入标记后改变 scrollTop。
// 真实时序：先处于底部（scrollTop=1600），再 wheel 上翻（scrollTop 减小）。
function simulateUserWheelUp() {
	expect(mockScrollerEl).not.toBeNull();
	// 用户滚轮输入（MessageList 监听 wheel 标记「用户滚动输入」）
	mockScrollerEl!.dispatchEvent(new Event("wheel", { bubbles: true }));
	// 贴底状态（scrollTop 增大，不触发停止）
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
	// 用户上翻：scrollTop 减小
	Object.defineProperty(mockScrollerEl!, "scrollTop", {
		value: 500,
		writable: true,
	});
	mockScrollerEl!.dispatchEvent(new Event("scroll", { bubbles: true }));
}

test("内容展开导致被动离底（无用户输入）→ 不误置 stickBottom、自动滚回底部", async () => {
	useSessionStore.setState({
		messagesBySession: {
			s1: [userMsg(1, "帮我查一下"), assistantMsg(2, "好的，委派子代理")],
		},
		statusBySession: { s1: "idle" },
	});
	render(<MessageList sessionId="s1" />);
	await waitFor(() => expect(scrollToIndexCalls.length).toBeGreaterThan(0));
	scrollToIndexCalls.length = 0;
	// 已贴底（进入会话定位完成后，Virtuoso 会在贴底时调 atBottomStateChange(true)）
	expect(mockAtBottomStateChange).not.toBeNull();
	mockAtBottomStateChange!(true);
	await new Promise((r) => setTimeout(r, 30));

	// 内容展开：某行从折叠变展开 → 内容变长 → maxScrollTop 增大，视口被动离开底部。
	// Virtuoso 数据变化后调用 atBottomStateChange(false)。用户没有滚动输入。
	mockAtBottomStateChange!(false);

	// 修复后：无用户输入 → 不置 stickBottom=false，且自动滚回底部（scrollToEnd 被调用）
	await waitFor(() => {
		expect(scrollToIndexCalls.length).toBeGreaterThan(0);
	});
});

test("内容折叠导致 scrollTop 被动减小（无用户输入）→ 不误置 stickBottom", async () => {
	useSessionStore.setState({
		messagesBySession: {
			s1: [userMsg(1, "帮我查一下"), assistantMsg(2, "好的，委派子代理")],
		},
		statusBySession: { s1: "idle" },
	});
	render(<MessageList sessionId="s1" />);
	await waitFor(() => expect(scrollToIndexCalls.length).toBeGreaterThan(0));
	scrollToIndexCalls.length = 0;
	// 已贴底
	mockAtBottomStateChange!(true);
	await new Promise((r) => setTimeout(r, 30));

	// 内容折叠：内容变短 → 浏览器被动 clamp scrollTop 减小（无用户输入）→ scroll 事件
	Object.defineProperty(mockScrollerEl!, "scrollTop", {
		value: 800,
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
	// 内容折叠：scrollHeight 同步减小（内容变短）→ maxScrollTop 减小 → 浏览器
	// 被动 clamp scrollTop（无用户输入）→ scroll 事件。maxScrollTop 同步减小是
	// 「被动 clamp」与「用户上翻」的关键区别（用户上翻时内容高度不变）。
	Object.defineProperty(mockScrollerEl!, "scrollHeight", {
		value: 1000,
		writable: true,
	});
	Object.defineProperty(mockScrollerEl!, "scrollTop", {
		value: 600,
		writable: true,
	});
	mockScrollerEl!.dispatchEvent(new Event("scroll", { bubbles: true }));
	// 折叠完成后仍在底部（新 maxScrollTop = 600 + 400 = 1000？非精确；这里简化：
	// Virtuoso 重新评估后 atBottomStateChange(true) 恢复贴底）
	mockAtBottomStateChange!(true);

	// 关键断言：无用户输入时 scroll 事件不应置 stickBottom=false。
	// 验证方式：若误置 false，后续「回到底部」不会自动滚动；修复后保持贴底，
	// 此刻再触发内容变化（展开）应自动滚回底部。
	scrollToIndexCalls.length = 0;
	mockAtBottomStateChange!(false); // 无用户输入 → 不置 false → 滚回底部
	await waitFor(() => {
		expect(scrollToIndexCalls.length).toBeGreaterThan(0);
	});
});

test("回归防护：用户主动上翻（wheel 输入）后仍停止跟随（319fd76b 语义保持）", async () => {
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
	await waitFor(() => expect(scrollToIndexCalls.length).toBeGreaterThan(0));
	await new Promise((r) => setTimeout(r, 250));
	const countBeforeScroll = scrollToIndexCalls.length;
	expect(countBeforeScroll).toBeGreaterThan(0);

	// 用户 wheel 上翻（输入标记 + scrollTop 减小）→ 停止跟随
	simulateUserWheelUp();
	await new Promise((r) => setTimeout(r, 600));
	expect(scrollToIndexCalls.length).toBe(countBeforeScroll);
});

// ============================================================================
// 触摸惯性滚动——不应被拉回底部（bug：惯性滚动被误判为「内容被动离底」→ 强制拉回）
// 背景：isUserScrollInput 只标记 wheel/touchstart/keydown/pointerdown。触摸屏惯性
// 滚动阶段（手指离开后）不再触发这些事件，但 scrollTop 持续变化。此时
// handleAtBottomChange(false) 走「内容被动离底」分支 → scrollToEnd() 把正在惯性
// 上翻的用户强制拉回底部，打断阅读。修复：scroll 事件里用 maxScrollTop 判定——
// scrollTop 减小且 maxScrollTop 未减小（无 clamp 理由）= 用户滚动（含惯性），
// 置 stickBottom=false；内容折叠时 maxScrollTop 同步减小才不判上翻。
// ============================================================================
test("触摸惯性滚动（无输入事件但 scrollTop 减小、maxScrollTop 不变）→ 视为用户上翻，不被拉回底部", async () => {
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
	await waitFor(() => expect(scrollToIndexCalls.length).toBeGreaterThan(0));
	await new Promise((r) => setTimeout(r, 250));
	const countBeforeScroll = scrollToIndexCalls.length;
	expect(countBeforeScroll).toBeGreaterThan(0);

	expect(mockScrollerEl).not.toBeNull();
	// 贴底基线（程序化贴底：scrollTop 增大，仅建立滚动基线）
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

	// 触摸惯性上翻：无任何输入事件（无 wheel/touch/pointer/keydown），
	// 仅原生 scroll——scrollTop 减小、maxScrollTop 不变（内容高度没变）
	Object.defineProperty(mockScrollerEl!, "scrollTop", {
		value: 500,
		writable: true,
	});
	mockScrollerEl!.dispatchEvent(new Event("scroll", { bubbles: true }));
	// Virtuoso 检测到离底（与真实浏览器一致：scroll 事件后回调）
	mockAtBottomStateChange!(false);

	// 修复后：惯性上翻视为用户上翻 → interval 停止（不被拉回底部）
	await new Promise((r) => setTimeout(r, 600));
	expect(scrollToIndexCalls.length).toBe(countBeforeScroll);
});

// ============================================================================
// 整轮折叠（isActiveTurnRow true→false）→ 主动滚回底部
// 背景：长任务执行中，进行中的轮（status=thinking 的末行 assistant）过程卡片展开，
// 用户贴底看实时过程。agent_end 到达、status 归 idle → isActiveTurnRow false →
// canCollapse true → 过程卡片折叠成 TurnSummary，末行高度骤减。Virtuoso 虚拟化行高
// 测量有延迟，折叠瞬间 scrollTop 停在旧位置（用户看到的内容不在底部）；且此时
// autoScrollActive 已 false，200ms interval 停止兑底。修复：折叠时刻主动 scrollToEnd。
// ============================================================================
test("整轮结束（isActiveTurnRow true→false）时主动滚动到底部", async () => {
	useSessionStore.setState({
		messagesBySession: {
			s1: [userMsg(1, "帮我查一下"), assistantMsg(2, "好的，委派子代理")],
		},
		statusBySession: { s1: "thinking" },
	});
	render(<MessageList sessionId="s1" />);
	// 等初始进入会话滚动完成（含 thinking 期间 interval 强制贴底）
	await waitFor(() => expect(scrollToIndexCalls.length).toBeGreaterThan(0));
	// 清空，观察「整轮结束」时刻是否新增一次 scrollToEnd
	scrollToIndexCalls.length = 0;

	// 整轮结束：status 归 idle → isActiveTurnRow true→false → 折叠 → 主动滚动
	useSessionStore.setState({ statusBySession: { s1: "idle" } });

	// 修复后：折叠时刻主动 scrollToEnd 一次（scrollToIndex 被调用）
	await waitFor(() => {
		expect(scrollToIndexCalls.length).toBeGreaterThan(0);
	});
	const last = scrollToIndexCalls[scrollToIndexCalls.length - 1];
	expect(last.index).toBe(1); // 末行
	expect(last.align).toBe("end");
});

// ============================================================================
// 回归：折叠补偿的单次 scrollToEnd 在 Virtuoso 行高缓存重测（ResizeObserver 异步）
// 之前执行，基于过期缓存计算的 scrollTop 不准；重测完成后位置可能再次偏移
// （视口停在中间），且此时 autoScrollActive 已 false、无任何路径再校正。
// 修复：折叠时刻启动收敛循环（同进入会话定位模式）：未贴底则拉回，贴底/用户
// 上翻/超时 2s 退出。
// ============================================================================
test("折叠后布局二次偏移（Virtuoso 异步重测）→ 收敛循环再次拉回底部", async () => {
	useSessionStore.setState({
		messagesBySession: {
			s1: [userMsg(1, "帮我查一下"), assistantMsg(2, "好的，委派子代理")],
		},
		statusBySession: { s1: "thinking" },
	});
	render(<MessageList sessionId="s1" />);
	await waitFor(() => expect(scrollToIndexCalls.length).toBeGreaterThan(0));

	// 贴底基线（scrollTop=1600 = maxScrollTop，距底 0）
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

	// 整轮结束：折叠 + 既有单次补偿
	scrollToIndexCalls.length = 0;
	useSessionStore.setState({ statusBySession: { s1: "idle" } });
	await waitFor(() => expect(scrollToIndexCalls.length).toBeGreaterThan(0));
	const countAfterCollapse = scrollToIndexCalls.length;

	// 模拟 ResizeObserver 异步重测后的二次布局：总高骤减、scrollTop 停在中部
	// （距底 100px）。maxScrollTop 同步减小 → handleScrollerScroll 不误判用户上翻，
	// stickBottom 保持 true。
	setTimeout(() => {
		Object.defineProperty(mockScrollerEl!, "scrollHeight", {
			value: 600,
			writable: true,
		});
		Object.defineProperty(mockScrollerEl!, "scrollTop", {
			value: 100,
			writable: true,
		});
		mockScrollerEl!.dispatchEvent(new Event("scroll", { bubbles: true }));
	}, 60);

	// 修复前：单次补偿已结束，偏移后无任何调用 → waitFor 超时失败
	// 修复后：收敛循环检测到未贴底 → 再次拉回
	await waitFor(
		() => {
			expect(scrollToIndexCalls.length).toBeGreaterThan(countAfterCollapse);
		},
		{ timeout: 1500 },
	);
	const last = scrollToIndexCalls[scrollToIndexCalls.length - 1];
	expect(last.index).toBe(1); // 末行
	expect(last.align).toBe("end");
});

test("折叠后布局二次偏移但用户已主动上翻 → 不得拉回", async () => {
	useSessionStore.setState({
		messagesBySession: {
			s1: [userMsg(1, "帮我查一下"), assistantMsg(2, "好的，委派子代理")],
		},
		statusBySession: { s1: "thinking" },
	});
	render(<MessageList sessionId="s1" />);
	await waitFor(() => expect(scrollToIndexCalls.length).toBeGreaterThan(0));

	// 贴底基线
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

	// 整轮结束：折叠 + 单次补偿
	scrollToIndexCalls.length = 0;
	useSessionStore.setState({ statusBySession: { s1: "idle" } });
	await waitFor(() => expect(scrollToIndexCalls.length).toBeGreaterThan(0));
	const countAfterCollapse = scrollToIndexCalls.length;

	// 用户主动上翻：wheel 输入 + scrollTop 减小且 maxScrollTop 不变 → stickBottom=false
	mockScrollerEl!.dispatchEvent(new Event("wheel", { bubbles: true }));
	Object.defineProperty(mockScrollerEl!, "scrollTop", {
		value: 1200,
		writable: true,
	});
	mockScrollerEl!.dispatchEvent(new Event("scroll", { bubbles: true }));

	// 布局二次偏移（Virtuoso 重测）——收敛循环必须尊重用户上翻，不得拉回
	setTimeout(() => {
		Object.defineProperty(mockScrollerEl!, "scrollHeight", {
			value: 600,
			writable: true,
		});
		Object.defineProperty(mockScrollerEl!, "scrollTop", {
			value: 300,
			writable: true,
		});
		mockScrollerEl!.dispatchEvent(new Event("scroll", { bubbles: true }));
	}, 60);

	await new Promise((r) => setTimeout(r, 700));
	expect(scrollToIndexCalls.length).toBe(countAfterCollapse);
});
