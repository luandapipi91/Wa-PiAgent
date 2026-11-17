// 自绘标题栏：仅 macOS 桌面版渲染；副标跟随主题标识（装饰性英文，不进 i18n）
import { test, expect, beforeEach, afterEach } from "bun:test";
import { render, screen } from "@testing-library/react";
import { TitleBar, shouldRenderTitleBar } from "./TitleBar";
import { useUiPrefsStore } from "../../store/ui-prefs";

const g = globalThis as unknown as { window: Window & { waPiApp?: unknown } };

beforeEach(() => {
	useUiPrefsStore.setState({ themeMode: "system" });
});
afterEach(() => {
	delete (g.window as { waPiApp?: unknown }).waPiApp;
});

test("浏览器环境（无 waPiApp）不渲染标题栏", () => {
	expect(shouldRenderTitleBar()).toBe(false);
	const { container } = render(<TitleBar />);
	expect(container.querySelector('[data-testid="titlebar"]')).toBeNull();
});

test("桌面版但非 macOS（win32）不渲染——保留原生窗口框", () => {
	(g.window as { waPiApp?: unknown }).waPiApp = { platform: "win32" };
	expect(shouldRenderTitleBar()).toBe(false);
	const { container } = render(<TitleBar />);
	expect(container.querySelector('[data-testid="titlebar"]')).toBeNull();
});

test("macOS 桌面版渲染标题栏，居中显示应用名与主题标识", () => {
	(g.window as { waPiApp?: unknown }).waPiApp = { platform: "darwin" };
	useUiPrefsStore.setState({ themeMode: "gilded" });
	render(<TitleBar />);
	const bar = screen.getByTestId("titlebar");
	expect(bar.textContent).toContain("WA PI AGENT");
	expect(screen.getByTestId("titlebar-theme").textContent).toBe("GILDED");
});

test("主题切到战术终端时副标跟随（含中文前缀）", () => {
	(g.window as { waPiApp?: unknown }).waPiApp = { platform: "darwin" };
	useUiPrefsStore.setState({ themeMode: "tactical" });
	render(<TitleBar />);
	expect(screen.getByTestId("titlebar-theme").textContent).toContain("TACTICAL");
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
