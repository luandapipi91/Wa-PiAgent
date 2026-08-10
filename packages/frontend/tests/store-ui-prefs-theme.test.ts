import { beforeEach, expect, test } from "bun:test";
import { useUiPrefsStore } from "../src/store/ui-prefs";

// mock matchMedia（happy-dom 不提供）
let darkMode = false;
beforeEach(() => {
	darkMode = false;
	Object.defineProperty(window, "matchMedia", {
		writable: true,
		value: (query: string) => ({
			matches: query.includes("dark") && darkMode,
			media: query,
			onchange: null,
			addEventListener: () => {},
			removeEventListener: () => {},
			addListener: () => {},
			removeListener: () => {},
			dispatchEvent: () => false,
		}),
	});
	document.documentElement.dataset.theme = "";
	document.documentElement.dataset.accent = "";
	localStorage.clear();
	// 重置 store 内存状态，避免前一个测试的改动影响后一个
	useUiPrefsStore.setState({ themeMode: "system", themeColor: "green" });
});

test("themeMode 默认为 system", async () => {
	const { useUiPrefsStore } = await import("../src/store/ui-prefs");
	expect(useUiPrefsStore.getState().themeMode).toBe("system");
});

test("themeColor 默认为 green", async () => {
	const { useUiPrefsStore } = await import("../src/store/ui-prefs");
	expect(useUiPrefsStore.getState().themeColor).toBe("green");
});

test("setThemeMode('dark') 设置 store 值并应用 data-theme 到 <html>", async () => {
	const { useUiPrefsStore } = await import("../src/store/ui-prefs");
	useUiPrefsStore.getState().setThemeMode("dark");
	expect(useUiPrefsStore.getState().themeMode).toBe("dark");
	expect(document.documentElement.dataset.theme).toBe("dark");
});

test("setThemeColor('blue') 设置 store 值并应用 data-accent 到 <html>", async () => {
	const { useUiPrefsStore } = await import("../src/store/ui-prefs");
	useUiPrefsStore.getState().setThemeColor("blue");
	expect(useUiPrefsStore.getState().themeColor).toBe("blue");
	expect(document.documentElement.dataset.accent).toBe("blue");
});

test("system 模式下 matchMedia 返回 light → data-theme 为 light", async () => {
	const { useUiPrefsStore } = await import("../src/store/ui-prefs");
	useUiPrefsStore.getState().setThemeMode("system");
	expect(document.documentElement.dataset.theme).toBe("light");
});

test("system 模式下 matchMedia 返回 dark → data-theme 为 dark", async () => {
	darkMode = true;
	const { useUiPrefsStore } = await import("../src/store/ui-prefs");
	useUiPrefsStore.getState().setThemeMode("system");
	expect(document.documentElement.dataset.theme).toBe("dark");
});
