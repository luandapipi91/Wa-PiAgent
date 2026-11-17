// 自绘标题栏：仅桌面版渲染（macOS / Windows），Web 与 Linux 不渲染。
// Windows 走 titleBarOverlay——组件要把主题色同步给系统绘制的窗口按钮区。
import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import { render, screen, waitFor } from "@testing-library/react";
import {
	TitleBar,
	shouldRenderTitleBar,
	toHex,
} from "./TitleBar";
import { useProjectsStore } from "../../store/projects";
import { useUiPrefsStore } from "../../store/ui-prefs";

const g = globalThis as unknown as { window: Window & { waPiApp?: unknown } };

beforeEach(() => {
	useUiPrefsStore.setState({ themeMode: "system" });
	useProjectsStore.setState({
		currentSessionId: null,
		currentProjectId: null,
		projects: [] as never,
		sessions: [] as never,
	});
});
afterEach(() => {
	delete (g.window as { waPiApp?: unknown }).waPiApp;
});

test("Web 模式（无 waPiApp）不渲染标题栏", () => {
	expect(shouldRenderTitleBar()).toBe(false);
	const { container } = render(<TitleBar />);
	expect(container.querySelector('[data-testid="titlebar"]')).toBeNull();
});

test("Linux 桌面版不渲染——保留原生窗口框", () => {
	(g.window as { waPiApp?: unknown }).waPiApp = { platform: "linux" };
	expect(shouldRenderTitleBar()).toBe(false);
	const { container } = render(<TitleBar />);
	expect(container.querySelector('[data-testid="titlebar"]')).toBeNull();
});

test("macOS 渲染标题栏，居中显示应用名与主题标识", () => {
	(g.window as { waPiApp?: unknown }).waPiApp = { platform: "darwin" };
	useUiPrefsStore.setState({ themeMode: "gilded" });
	render(<TitleBar />);
	expect(screen.getByTestId("titlebar").textContent).toContain("WA PI AGENT");
	expect(screen.getByTestId("titlebar-theme").textContent).toBe("GILDED");
});

test("Windows 也渲染标题栏（窗口按钮由系统画在右侧）", () => {
	(g.window as { waPiApp?: unknown }).waPiApp = {
		platform: "win32",
		setTitleBarOverlay: mock(() => Promise.resolve(true)),
	};
	useUiPrefsStore.setState({ themeMode: "tactical" });
	render(<TitleBar />);
	expect(screen.getByTestId("titlebar")).toBeTruthy();
	expect(screen.getByTestId("titlebar-theme").textContent).toContain("TACTICAL");
});

test("Windows 下把主题标题栏配色同步给系统按钮区", async () => {
	const setTitleBarOverlay = mock(() => Promise.resolve(true));
	(g.window as { waPiApp?: unknown }).waPiApp = {
		platform: "win32",
		setTitleBarOverlay,
	};
	render(<TitleBar />);
	await waitFor(() => expect(setTitleBarOverlay).toHaveBeenCalled());
	type OverlayArg = { color: string; symbolColor: string; height: number };
	const arg = (setTitleBarOverlay.mock.calls[0] as unknown as [OverlayArg])[0];
	// 必须是 #RRGGBB——Electron 的 overlay 不接受 rgba/命名色
	expect(arg.color).toMatch(/^#[0-9a-f]{6}$/);
	expect(arg.symbolColor).toMatch(/^#[0-9a-f]{6}$/);
	expect(arg.height).toBe(40);
});

test("macOS 不调用 overlay 同步（没有系统按钮区需要染色）", async () => {
	const setTitleBarOverlay = mock(() => Promise.resolve(true));
	(g.window as { waPiApp?: unknown }).waPiApp = {
		platform: "darwin",
		setTitleBarOverlay,
	};
	render(<TitleBar />);
	await new Promise((r) => setTimeout(r, 60));
	expect(setTitleBarOverlay).not.toHaveBeenCalled();
});

test("八套主题都有对应的主题标识，不留空白副标", () => {
	(g.window as { waPiApp?: unknown }).waPiApp = { platform: "darwin" };
	for (const mode of [
		"system",
		"light",
		"dark",
		"newspaper",
		"pixel",
		"cyber",
		"gilded",
		"tactical",
	] as const) {
		useUiPrefsStore.setState({ themeMode: mode });
		const { unmount } = render(<TitleBar />);
		expect(screen.getByTestId("titlebar-theme").textContent?.trim()).not.toBe("");
		unmount();
	}
});

test("颜色归一：hex 小写、3 位展开、rgb 转 hex、非法值回退", () => {
	expect(toHex("#1A1A1E", "#000000")).toBe("#1a1a1e");
	expect(toHex("#fff", "#000000")).toBe("#ffffff");
	expect(toHex("rgb(10, 10, 10)", "#000000")).toBe("#0a0a0a");
	expect(toHex("rgba(255, 255, 255, 0.12)", "#000000")).toBe("#ffffff");
	expect(toHex("oklch(0.5 0.1 200)", "#123456")).toBe("#123456");
	expect(toHex("", "#abcdef")).toBe("#abcdef");
});

test("副标显示当前选中的项目名", () => {
	(g.window as { waPiApp?: unknown }).waPiApp = { platform: "darwin" };
	useUiPrefsStore.setState({ themeMode: "newspaper" });
	useProjectsStore.setState({
		projects: [
			{ id: "p-1", name: "默认工作区" },
			{ id: "p-2", name: "Wa-Pi" },
		] as never,
		sessions: [
			{ id: "s-1", projectId: "p-1", title: "会话一" },
			{ id: "s-2", projectId: "p-2", title: "会话二" },
		] as never,
		currentProjectId: "p-2",
		currentSessionId: "s-2",
	});
	render(<TitleBar />);
	expect(screen.getByTestId("titlebar-theme").textContent).toBe("Wa-Pi");
});

test("切换选中的会话，副标跟着换到该会话所属项目", () => {
	(g.window as { waPiApp?: unknown }).waPiApp = { platform: "darwin" };
	useUiPrefsStore.setState({ themeMode: "gilded" });
	useProjectsStore.setState({
		projects: [
			{ id: "p-1", name: "默认工作区" },
			{ id: "p-2", name: "Wa-Pi" },
		] as never,
		sessions: [
			{ id: "s-1", projectId: "p-1", title: "会话一" },
			{ id: "s-2", projectId: "p-2", title: "会话二" },
		] as never,
		currentProjectId: "p-1",
		currentSessionId: "s-1",
	});
	const { rerender } = render(<TitleBar />);
	expect(screen.getByTestId("titlebar-theme").textContent).toBe("默认工作区");
	useProjectsStore.setState({ currentSessionId: "s-2", currentProjectId: "p-2" });
	rerender(<TitleBar />);
	expect(screen.getByTestId("titlebar-theme").textContent).toBe("Wa-Pi");
});

test("没有选中会话时副标回落到主题标记", () => {
	(g.window as { waPiApp?: unknown }).waPiApp = { platform: "darwin" };
	useUiPrefsStore.setState({ themeMode: "newspaper" });
	useProjectsStore.setState({ sessions: [] as never, projects: [] as never, currentSessionId: null });
	render(<TitleBar />);
	expect(screen.getByTestId("titlebar-theme").textContent).toBe("NEWSPAPER");
});

test("只有项目、没选会话时只显示项目名", () => {
	(g.window as { waPiApp?: unknown }).waPiApp = { platform: "darwin" };
	useUiPrefsStore.setState({ themeMode: "newspaper" });
	useProjectsStore.setState({
		projects: [{ id: "p-2", name: "batocera-roms" }] as never,
		sessions: [] as never,
		currentProjectId: "p-2",
		currentSessionId: null,
	});
	render(<TitleBar />);
	expect(screen.getByTestId("titlebar-theme").textContent).toBe("batocera-roms");
});

test("当前项目的记录丢失时回落到主题标记", () => {
	(g.window as { waPiApp?: unknown }).waPiApp = { platform: "darwin" };
	useUiPrefsStore.setState({ themeMode: "gilded" });
	useProjectsStore.setState({
		projects: [] as never,
		sessions: [{ id: "s-1", projectId: "p-x", title: "孤儿会话" }] as never,
		currentProjectId: "p-x",
		currentSessionId: "s-1",
	});
	render(<TitleBar />);
	expect(screen.getByTestId("titlebar-theme").textContent).toBe("GILDED");
});
