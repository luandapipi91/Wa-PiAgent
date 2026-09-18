// agent 请求打开预览（preview:open 事件）的前端接线测试：
// - 事件属于「当前会话」→ 立即打开（外部网址走 openExternal，本地 html 走 openBrowser）
// - 事件属于「非当前会话」→ 只记入该会话的预览记忆（bySession），不动当前显示；切回恢复
// 事件用真实 events 模块的测试钩子注入（happy-dom 无 EventSource，connect 自动 no-op），
// 因此这里锁的就是 onEventType("preview:open") 的真实分发链路。
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { disconnectEvents, emitEventForTesting } from "./events";
import { useBrowserStore } from "./store/browser";
import { useProjectsStore } from "./store/projects";
import { useAgentPreviewOpener } from "./agent-preview-opener";
import type { PreviewOpenEvent } from "@wa-pi/shared";

function emit(e: PreviewOpenEvent): void {
	emitEventForTesting(e);
}

beforeEach(() => {
	useBrowserStore.setState({
		open: false,
		path: null,
		externalUrl: null,
		sessionId: null,
		minimized: false,
		bySession: {},
	});
	useProjectsStore.setState({ currentSessionId: null });
});

afterEach(() => {
	cleanup();
	disconnectEvents();
});

test("当前会话 + 外部网址 → 立即打开外部预览", () => {
	useProjectsStore.setState({ currentSessionId: "s1" });
	renderHook(() => useAgentPreviewOpener());

	emit({
		type: "preview:open",
		sessionId: "s1",
		target: { kind: "url", url: "https://example.com/demo" },
	});

	const s = useBrowserStore.getState();
	expect(s.open).toBe(true);
	expect(s.externalUrl).toBe("https://example.com/demo");
	expect(s.path).toBeNull();
	expect(s.sessionId).toBe("s1");
	expect(s.bySession.s1).toEqual({
		open: true,
		path: null,
		url: "https://example.com/demo",
		minimized: false,
	});
});

test("当前会话 + 本地 html → 立即打开本地预览", () => {
	useProjectsStore.setState({ currentSessionId: "s1" });
	renderHook(() => useAgentPreviewOpener());

	emit({
		type: "preview:open",
		sessionId: "s1",
		target: { kind: "local", path: "/proj/index.html" },
	});

	const s = useBrowserStore.getState();
	expect(s.open).toBe(true);
	expect(s.path).toBe("/proj/index.html");
	expect(s.externalUrl).toBeNull();
	expect(s.sessionId).toBe("s1");
});

test("非当前会话 + 外部网址 → 不动当前显示，只写该会话记忆；切回恢复", () => {
	useProjectsStore.setState({ currentSessionId: "s1" });
	useBrowserStore.getState().openBrowser("/proj/cur.html", "s1");
	renderHook(() => useAgentPreviewOpener());

	emit({
		type: "preview:open",
		sessionId: "s2",
		target: { kind: "url", url: "https://example.com/other" },
	});

	// 当前显示（s1 的本地预览）原样不动
	const s = useBrowserStore.getState();
	expect(s.sessionId).toBe("s1");
	expect(s.path).toBe("/proj/cur.html");
	expect(s.externalUrl).toBeNull();
	// s2 只被记入记忆
	expect(s.bySession.s2).toEqual({
		open: true,
		path: null,
		url: "https://example.com/other",
		minimized: false,
	});

	// 切回 s2：恢复出外部预览
	useBrowserStore.getState().activateSession("s2");
	expect(useBrowserStore.getState().externalUrl).toBe(
		"https://example.com/other",
	);
	expect(useBrowserStore.getState().path).toBeNull();
});

test("非当前会话 + 本地 html → 只写记忆，切回恢复本地预览", () => {
	useProjectsStore.setState({ currentSessionId: "s1" });
	renderHook(() => useAgentPreviewOpener());

	emit({
		type: "preview:open",
		sessionId: "s2",
		target: { kind: "local", path: "/proj/other.html" },
	});

	expect(useBrowserStore.getState().open).toBe(false);
	expect(useBrowserStore.getState().bySession.s2?.path).toBe(
		"/proj/other.html",
	);
	useBrowserStore.getState().activateSession("s2");
	expect(useBrowserStore.getState().open).toBe(true);
	expect(useBrowserStore.getState().path).toBe("/proj/other.html");
});

test("无当前会话（新建/空视图）→ 按非当前处理：只写记忆，不弹出", () => {
	renderHook(() => useAgentPreviewOpener());

	emit({
		type: "preview:open",
		sessionId: "s9",
		target: { kind: "url", url: "https://example.com/x" },
	});

	expect(useBrowserStore.getState().open).toBe(false);
	expect(useBrowserStore.getState().externalUrl).toBeNull();
	expect(useBrowserStore.getState().bySession.s9?.url).toBe(
		"https://example.com/x",
	);
});

test("卸载后取消订阅：再来的事件不再生效", () => {
	useProjectsStore.setState({ currentSessionId: "s1" });
	const { unmount } = renderHook(() => useAgentPreviewOpener());

	// 订阅生效期间：事件被处理
	emit({
		type: "preview:open",
		sessionId: "s1",
		target: { kind: "url", url: "https://example.com/first" },
	});
	expect(useBrowserStore.getState().externalUrl).toBe(
		"https://example.com/first",
	);

	unmount();
	emit({
		type: "preview:open",
		sessionId: "s1",
		target: { kind: "url", url: "https://example.com/late" },
	});

	// 卸载后：状态停在上一次，新事件不再被处理
	expect(useBrowserStore.getState().externalUrl).toBe(
		"https://example.com/first",
	);
	expect(useBrowserStore.getState().bySession.s1?.url).toBe(
		"https://example.com/first",
	);
});
