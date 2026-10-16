// use-is-dark-mode.ts — 订阅「实际渲染的明暗模式」。
// 事实源与 ui-prefs 的 applyThemeMode 一致：themeMode 为 system 时跟随
// OS prefers-color-scheme，并在系统切换时自动更新（用于 Prism 等需要按
// 明暗切换配色的第三方渲染，CSS 变量无法表达）。
import { useEffect, useState } from "react";
import { resolveActualTheme, useUiPrefsStore } from "../store/ui-prefs";

/** 当前实际明暗：dark=true。非浏览器环境（测试 SSR 等）兜底为浅色。 */
export function useIsDarkMode(): boolean {
	const themeMode = useUiPrefsStore((s) => s.themeMode);
	const [isDark, setIsDark] = useState<boolean>(() => {
		try {
			return resolveActualTheme(themeMode) === "dark";
		} catch {
			return false;
		}
	});

	useEffect(() => {
		try {
			setIsDark(resolveActualTheme(themeMode) === "dark");
		} catch {
			return;
		}
		if (themeMode !== "system") return;
		const mql = window.matchMedia("(prefers-color-scheme: dark)");
		const onChange = () => setIsDark(mql.matches);
		mql.addEventListener("change", onChange);
		return () => mql.removeEventListener("change", onChange);
	}, [themeMode]);

	return isDark;
}
