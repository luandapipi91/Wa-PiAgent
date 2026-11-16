import { beforeEach, expect, test } from "bun:test";
import {
	THEME_COLOR_DEFAULT,
	THEME_MODE_DEFAULT,
	isAccentApplicable,
	isDarkTheme,
	resolveActualTheme,
	useUiPrefsStore,
} from "../src/store/ui-prefs";

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

// 直接断言导出的默认值常量，绕开 store 单例被 beforeEach 重置造成的自证循环
// （若实现里默认值被错改，读回 store 仍会得到 beforeEach 写入的值，无法暴露问题）。
test("themeMode 默认为 system", () => {
	expect(THEME_MODE_DEFAULT).toBe("system");
});

test("themeColor 默认为 green", () => {
	expect(THEME_COLOR_DEFAULT).toBe("green");
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

test("setThemeMode('light') 应用 data-theme='light' 到 <html>", async () => {
	const { useUiPrefsStore } = await import("../src/store/ui-prefs");
	useUiPrefsStore.getState().setThemeMode("light");
	expect(useUiPrefsStore.getState().themeMode).toBe("light");
	expect(document.documentElement.dataset.theme).toBe("light");
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

test("resolveActualTheme 对三套新主题直通", () => {
	for (const mode of ["newspaper", "pixel", "cyber"] as const) {
		expect(resolveActualTheme(mode)).toBe(mode);
	}
});

test("isDarkTheme：dark/pixel/cyber 为暗，light/newspaper 为亮", () => {
	expect(isDarkTheme("dark")).toBe(true);
	expect(isDarkTheme("pixel")).toBe(true);
	expect(isDarkTheme("cyber")).toBe(true);
	expect(isDarkTheme("light")).toBe(false);
	expect(isDarkTheme("newspaper")).toBe(false);
});

test("isAccentApplicable：三套新主题不可换强调色", () => {
	expect(isAccentApplicable("newspaper")).toBe(false);
	expect(isAccentApplicable("pixel")).toBe(false);
	expect(isAccentApplicable("cyber")).toBe(false);
	expect(isAccentApplicable("light")).toBe(true);
	expect(isAccentApplicable("dark")).toBe(true);
	expect(isAccentApplicable("system")).toBe(true);
});

test("setThemeMode('pixel') 把 data-theme 写为 pixel", () => {
	useUiPrefsStore.getState().setThemeMode("pixel");
	expect(useUiPrefsStore.getState().themeMode).toBe("pixel");
	expect(document.documentElement.dataset.theme).toBe("pixel");
});
