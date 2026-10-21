// 独立预览窗口根（浮动模式的承载窗口）测试：
// 两个渲染进程 store 不共享，本窗口的内容靠「URL 参数自举」+「主进程 sync 消息」两条路进来。
// 外部网址（agent preview_open / 地址栏输入网址）同样走这两条路，故这里锁：
// - 自举：params.url → 外部预览；params.path → 本地预览
// - sync：带 url 优先用 url，否则回落到 path
// BrowserPanel 子树在这里被 mock 掉：本组件的职责是 store 接线，面板渲染另由 BrowserPanel 测试锁定。
import { beforeEach, afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";

mock.module("./BrowserPanel", () => ({
	BrowserPanel: () => null,
}));
mock.module("./blocks/FilePreviewModal", () => ({
	FilePreviewModal: () => null,
}));
mock.module("./ui/Toast", () => ({
	ToastContainer: () => null,
}));
mock.module("../store/projects", () => ({
	useProjectsStore: Object.assign((sel: any) => sel({}), {
		getState: () => ({ load: () => {}, projects: [], currentSessionId: null }),
	}),
}));

import { PreviewWindowRoot } from "./PreviewWindowRoot";
import { useBrowserStore } from "../store/browser";
import type { PreviewWinEvent } from "../preview-window";

let listeners: Array<(e: PreviewWinEvent) => void>;
let acts: any[];

function installBridge() {
	listeners = [];
	acts = [];
	(window as any).waPiPreviewWin = {
		open: async () => ({ ok: true }),
		cmd: () => {},
		act: (p: any) => acts.push(p),
		setSize: () => {},
		onEvent: (cb: any) => {
			listeners.push(cb);
			return () => {
				listeners = listeners.filter((l) => l !== cb);
			};
		},
	};
}

/** 模拟主进程下发到本窗口的 sync 消息 */
function emitSync(e: PreviewWinEvent): void {
	for (const l of listeners) l(e);
}

function setSearch(search: string): void {
	(window as any).happyDOM?.setURL?.(`http://localhost/${search}`);
}

beforeEach(() => {
	installBridge();
	useBrowserStore.setState({
		open: false,
		path: null,
		externalUrl: null,
		sessionId: null,
		minimized: false,
		mode: "float",
		bySession: {},
	});
});

afterEach(() => {
	cleanup();
	delete (window as any).waPiPreviewWin;
	setSearch("");
});

test("自举：URL 带 url 参数 → 打开外部预览（不用 path）", () => {
	setSearch("?wa-preview-win=1&url=https%3A%2F%2Fexample.com%2Fboot&sid=s-1");
	render(<PreviewWindowRoot />);
	const s = useBrowserStore.getState();
	expect(s.open).toBe(true);
	expect(s.externalUrl).toBe("https://example.com/boot");
	expect(s.path).toBeNull();
	expect(s.sessionId).toBe("s-1");
	// 首帧渲染完成 → 请求主进程显示窗口
	expect(acts).toEqual([{ type: "ready" }]);
});

test("自举：URL 只带 path → 维持本地预览（不因 url 缺失而清空）", () => {
	setSearch(
		"?wa-preview-win=1&path=%2Fproj%2Findex.html&sid=s-1",
	);
	render(<PreviewWindowRoot />);
	const s = useBrowserStore.getState();
	expect(s.path).toBe("/proj/index.html");
	expect(s.externalUrl).toBeNull();
});

test("sync 带 url → 本窗口切到外部网址（主窗口 agent 请求打开网址）", () => {
	setSearch("?wa-preview-win=1&path=%2Fproj%2Findex.html&sid=s-1");
	render(<PreviewWindowRoot />);
	emitSync({
		type: "sync",
		path: null,
		url: "https://example.com/live",
		sessionId: "s-2",
	});
	const s = useBrowserStore.getState();
	expect(s.externalUrl).toBe("https://example.com/live");
	expect(s.path).toBeNull();
	expect(s.sessionId).toBe("s-2");
});

test("sync 的 url 为 null → 回落本地 path（从网址切回本地文件）", () => {
	setSearch("?wa-preview-win=1&url=https%3A%2F%2Fexample.com%2Fboot&sid=s-1");
	render(<PreviewWindowRoot />);
	emitSync({
		type: "sync",
		path: "/proj/back.html",
		url: null,
		sessionId: "s-1",
	});
	const s = useBrowserStore.getState();
	expect(s.path).toBe("/proj/back.html");
	expect(s.externalUrl).toBeNull();
});

test("收到主窗口转发的 refresh 事件 → 本窗口刷新令牌递增（iframe 重挂实现自动刷新）", async () => {
	render(<PreviewWindowRoot />);
	await waitFor(() => expect(listeners.length).toBeGreaterThan(0));
	const before = useBrowserStore.getState().refreshToken;
	act(() => emitSync({ type: "refresh" } as any));
	expect(useBrowserStore.getState().refreshToken).toBe(before + 1);
});
