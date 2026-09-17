// 会话切换首屏契约（加载体验修复）：
// 用户实测：切会话「先渲染首屏（顶部）→ 跳转到底部」两段式闪烁。
// 根因：historyLoading 移除（spinner 撤）与首次贴底定位（scrollToEnd）分离，
// Virtuoso 首帧从 index 0 渲染。
// 修复：①Virtuoso initialTopMostItemIndex（挂载即贴底）；
// ②列表容器在「历史已加载 + 首次贴底」之前保持不可见（loading 覆盖），
//   用户只看到 loading → 已贴底列表 一次切换；2s 超时兜底。
import { test, expect, beforeEach, mock } from "bun:test";
import { render, act, waitFor } from "@testing-library/react";
import { MessageList } from "../src/components/MessageList";
import { VirtuosoMockContext } from "react-virtuoso";
import { useSessionStore } from "../src/store/session";
import type { SessionMessage } from "@wa-pi/shared";

// MessageList mount effect 会拉历史：mock 成可控 deferred（手动决定何时就绪）
let resolveMessages!: (v: any) => void;
const MESSAGES_PAYLOAD = {
	messages: Array.from({ length: 40 }, (_, i) => ({
		role: i % 2 ? "assistant" : "user",
		content: `消息${i}`,
		timestamp: i + 1,
	})),
	isActive: false,
	thinkingSince: null,
};
mock.module("../src/api-client", () => ({
	api: {
		get: (path: string) => {
			if (path.endsWith("/messages")) {
				return new Promise((r) => {
					resolveMessages = r;
				});
			}
			return Promise.resolve({});
		},
		post: async () => ({}),
		put: async () => ({}),
		del: async () => ({}),
	},
}));

function msg(timestamp: number, role: "user" | "assistant", text: string): SessionMessage {
	return {
		message: { role, content: text, timestamp },
	} as unknown as SessionMessage;
}

beforeEach(() => {
	useSessionStore.setState({
		messagesBySession: {},
		streamingBySession: {},
		historyLoadingBySession: {},
	});
});

test("历史加载中（首次进入无缓存）：列表不挂载（loading 覆盖，不露顶部首屏）", () => {
	useSessionStore.setState({
		messagesBySession: { s1: [] },
		historyLoadingBySession: { s1: true },
	});
	const { container } = render(
		<VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 60 }}>
			<MessageList sessionId="s1" />
		</VirtuosoMockContext.Provider>,
	);
	// 加载中：Virtuoso 不挂载（列表不存在 → 不可能露顶部首屏）
	expect(container.querySelector('[data-testid="message-list"]')).toBeNull();
});

test("历史就绪：列表挂载对齐 skeleton 撤除（无重叠），全量 data 渲染", async () => {
	const { container } = render(
		<VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 60 }}>
			<MessageList sessionId="s1" />
		</VirtuosoMockContext.Provider>,
	);
	// 模拟历史拉取完成（SessionView finally 的效果）：loading 撤 + 全量消息入 store
	act(() => {
		useSessionStore.setState({
			messagesBySession: {
				s1: Array.from({ length: 40 }, (_, i) =>
					msg(i + 1, i % 2 ? "assistant" : "user", `消息${i}`),
				),
			},
			historyLoadingBySession: { s1: false },
		});
	});
	// skeleton 有 500ms 最小展示（防一闪而过），列表挂载对齐其撤除时机——
	// 挂载时 skeleton 必已撤除（重叠契约）；真实浏览器首帧贴底由 useLayoutEffect 保证
	await waitFor(() => {
		expect(container.querySelector('[data-testid="message-list"]')).toBeTruthy();
	}, { timeout: 2000 });
	expect(container.querySelector('[data-testid="history-loading-s1"]')).toBeNull();
	expect(container.textContent).toContain("消息0");
	// paint 前同步贴底（scrollTop 直设）是时序行为，happy-dom 无真实几何不可测，
	// 由 lag-fix-smoke E2E 在真实 Chromium 断言（scrollTop 立即贴底）
});
