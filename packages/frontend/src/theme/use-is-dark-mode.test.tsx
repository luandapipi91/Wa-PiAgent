// use-is-dark-mode 测试：跟随 themeMode；system 模式下监听 OS 偏好变化。
import { test, expect, afterEach } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { useIsDarkMode } from "./use-is-dark-mode";
import { useUiPrefsStore } from "../store/ui-prefs";

/** 记录当前 matchMedia 处理器，方便测试内手动触发系统切换。 */
let currentChangeListener: ((e: MediaQueryListEvent) => void) | null = null;
/** 当前 mock 的 MediaQueryList 单例：真实 OS 切换是同一对象更新 matches + 触发 change。 */
let currentMql: { matches: boolean } | null = null;

function mockMatchMedia(matches: boolean) {
	const mql = {
		matches,
		media: "(prefers-color-scheme: dark)",
		onchange: null,
		addEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => {
			currentChangeListener = cb;
		},
		removeEventListener: () => {
			currentChangeListener = null;
		},
	} as unknown as MediaQueryList;
	currentMql = mql;
	(globalThis as any).matchMedia = () => mql;
}

/** 模拟系统明暗切换：同一对象更新 matches 并触发 change 事件。 */
function setSystemDark(dark: boolean) {
	if (!currentMql) return;
	currentMql.matches = dark;
	act(() => {
		currentChangeListener?.({ matches: dark } as MediaQueryListEvent);
	});
}

afterEach(() => {
	// 恢复默认 system，避免测试间互相影响
	useUiPrefsStore.getState().setThemeMode("system");
	currentChangeListener = null;
});

test("light 模式 → isDark=false", () => {
	mockMatchMedia(false);
	useUiPrefsStore.getState().setThemeMode("light");
	const { result } = renderHook(() => useIsDarkMode());
	expect(result.current).toBe(false);
});

test("dark 模式 → isDark=true", () => {
	mockMatchMedia(false);
	useUiPrefsStore.getState().setThemeMode("dark");
	const { result } = renderHook(() => useIsDarkMode());
	expect(result.current).toBe(true);
});

test("system 模式跟随 OS 偏好（dark → isDark=true）", () => {
	mockMatchMedia(true);
	useUiPrefsStore.getState().setThemeMode("system");
	const { result } = renderHook(() => useIsDarkMode());
	expect(result.current).toBe(true);
});

test("system 模式下 OS 切换会更新 isDark", () => {
	mockMatchMedia(true);
	useUiPrefsStore.getState().setThemeMode("system");
	const { result } = renderHook(() => useIsDarkMode());
	expect(result.current).toBe(true);

	// 模拟系统从 dark 切到 light：同一 mql 更新 matches + 触发 change
	setSystemDark(false);
	expect(result.current).toBe(false);
});

test("themeMode 切换时 isDark 同步更新", () => {
	mockMatchMedia(false);
	useUiPrefsStore.getState().setThemeMode("light");
	const { result } = renderHook(() => useIsDarkMode());
	expect(result.current).toBe(false);

	act(() => {
		useUiPrefsStore.getState().setThemeMode("dark");
	});
	expect(result.current).toBe(true);
});
