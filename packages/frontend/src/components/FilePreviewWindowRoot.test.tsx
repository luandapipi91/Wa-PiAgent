// 文件预览独立窗口根（?wa-preview-win=1&kind=file）测试：
// 与 PreviewWindowRoot 同款「URL 自举 + 主进程 sync 消息」两条内容进入路径，另有
// 窗口内 md 相对链接跳转（写窗口自己的 sessionStore，由本组件消费并回传主窗口）。
// FileViewer 子树在这里被 mock 成桩：本组件的职责是窗口编排（标题栏/缩放/事件接线），
// 文件内容渲染另由 FileViewer 测试锁定。
import { beforeEach, afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";

mock.module("./blocks/FileViewer", () => ({
	FileViewer: (props: any) => (
		<div
			data-testid="file-viewer-stub"
			data-path={props.path}
			data-session={props.sessionId}
			data-toolbar-portal-id={props.toolbarPortalId ?? ""}
		>
			<button data-testid="stub-close" onClick={props.onClose} />
		</div>
	),
}));
mock.module("./ui/Toast", () => ({
	ToastContainer: () => null,
}));

import { FilePreviewWindowRoot } from "./FilePreviewWindowRoot";
import { useSessionStore } from "../store/session";
import { useSettingsStore } from "../store/settings";
import type { FilePreviewWinEvent } from "../preview-window";

let listeners: Array<(e: FilePreviewWinEvent) => void>;
let acts: any[];
let sizes: any[];

function installBridge() {
	listeners = [];
	acts = [];
	sizes = [];
	(window as any).waPiFilePreviewWin = {
		open: async () => ({ ok: true }),
		cmd: () => {},
		act: (p: any) => acts.push(p),
		setSize: (p: any) => sizes.push(p),
		onEvent: (cb: any) => {
			listeners.push(cb);
			return () => {
				listeners = listeners.filter((l) => l !== cb);
			};
		},
	};
}

function emit(e: any): void {
	act(() => {
		for (const l of listeners) l(e);
	});
}

function setSearch(search: string): void {
	(window as any).happyDOM?.setURL?.(`http://localhost/${search}`);
}

function renderRoot() {
	return render(
		<FilePreviewWindowRoot initialPath="/p/notes/a.md" initialSessionId="s1" />,
	);
}

beforeEach(() => {
	installBridge();
	useSessionStore.setState({ filePreview: null });
});

afterEach(() => {
	cleanup();
	delete (window as any).waPiFilePreviewWin;
	setSearch("");
	useSessionStore.setState({ filePreview: null });
});

test("渲染：标题栏文件名 + FileViewer 以 initialPath 自举", () => {
	const { getByTestId } = renderRoot();
	expect(getByTestId("file-preview-window-root").textContent).toContain("a.md");
	expect(getByTestId("file-viewer-stub").getAttribute("data-path")).toBe("/p/notes/a.md");
	expect(getByTestId("file-viewer-stub").getAttribute("data-session")).toBe("s1");
	// 窗口形态：FileViewer 的分享/复制按钮 portal 进标题栏槽位（同一行），标题栏 ✕ 唯一关闭
	expect(getByTestId("file-viewer-stub").getAttribute("data-toolbar-portal-id")).toBe(
		"fv-toolbar-slot",
	);
	expect(getByTestId("fv-toolbar-slot")).toBeTruthy();
	// 缩放手柄（右下角）
	expect(getByTestId("preview-window-resize")).toBeTruthy();
});

test("挂载即 act ready 并设置 document.title（无边框窗口的任务栏标题）", () => {
	renderRoot();
	expect(acts).toEqual([{ type: "ready" }]);
	expect(document.title).toBe("a.md · WA PI Agent");
});

test("标题栏关闭按钮 → act close（窗口要消失，不走本地 store）", () => {
	const { getByTestId } = renderRoot();
	fireEvent.click(getByTestId("file-preview-titlebar-close"));
	expect(acts).toContainEqual({ type: "close" });
});

test("FileViewer 内部 onClose 同样走 act close", () => {
	const { getByTestId } = renderRoot();
	fireEvent.click(getByTestId("stub-close"));
	expect(acts).toContainEqual({ type: "close" });
});

test("sync 事件换内容（单例复用路径）；同值不产生变更（守卫防回环重渲染）", async () => {
	const { getByTestId } = renderRoot();
	emit({ type: "sync", path: "/p/notes/b.md", sessionId: "s1" });
	await waitFor(() =>
		expect(getByTestId("file-viewer-stub").getAttribute("data-path")).toBe("/p/notes/b.md"),
	);
	emit({ type: "sync", path: "/p/notes/b.md", sessionId: "s1" });
	expect(getByTestId("file-viewer-stub").getAttribute("data-path")).toBe("/p/notes/b.md");
});

test("窗口内 md 相对链接跳转：写窗口自己的 sessionStore → 本地换内容 + act path 回传主窗口", async () => {
	const { getByTestId } = renderRoot();
	act(() => {
		useSessionStore.getState().openFilePreview("/p/notes/c.md", "s1");
	});
	await waitFor(() =>
		expect(getByTestId("file-viewer-stub").getAttribute("data-path")).toBe("/p/notes/c.md"),
	);
	expect(acts).toContainEqual({ type: "path", path: "/p/notes/c.md", sessionId: "s1" });
});

test("ResizeHandle 拖动提交尺寸：setSize 走文件桥", () => {
	const { getByTestId } = renderRoot();
	const handle = getByTestId("preview-window-resize");
	fireEvent.mouseDown(handle);
	fireEvent.mouseMove(window, { screenX: 800, screenY: 600 });
	expect(sizes.length).toBeGreaterThan(0);
	expect(sizes[0]).toEqual({ w: 800, h: 600 });
});

test("设置转发：窗口内 showSettings 置位 → act open-settings 且本地立即复位", () => {
	renderRoot();
	act(() => {
		useSettingsStore.getState().open();
		useSettingsStore.getState().setSection("share");
	});
	expect(acts).toContainEqual({ type: "open-settings", section: "share" });
	expect(useSettingsStore.getState().showSettings).toBe(false);
});
