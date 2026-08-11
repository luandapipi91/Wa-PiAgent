// CodeBlockCard 主题测试：暗色模式下 Prism token 颜色切换为浅色系（可读）。
import { test, expect, afterEach } from "bun:test";
import { render, act } from "@testing-library/react";
import { CodeBlockCard } from "./CodeBlockCard";
import { useUiPrefsStore } from "../../store/ui-prefs";

function mockMatchMedia(matches: boolean) {
	(globalThis as any).matchMedia = () =>
		({
			matches,
			media: "(prefers-color-scheme: dark)",
			onchange: null,
			addEventListener: () => {},
			removeEventListener: () => {},
		}) as unknown as MediaQueryList;
}

afterEach(() => {
	useUiPrefsStore.getState().setThemeMode("system");
});

/** 取第一个带 color 内联样式的 token span（行号 span 无 color）。 */
function firstTokenColor(): string | null {
	const spans = document.querySelectorAll(
		'[data-testid="code-block-card"] pre span',
	);
	for (const s of spans) {
		const style = s.getAttribute("style") ?? "";
		const m = /color:\s*(#[0-9a-fA-F]+|rgb\([^)]+\)|hsl\([^)]+\))/.exec(style);
		if (m) return m[1];
	}
	return null;
}

/** 粗略亮度（0-255，越大越浅）：rgb 三通道均值；hsl 的 h/s 换行规避，按 l 解析。 */
function brightness(color: string): number | null {
	const rgb = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(color);
	if (rgb) return (Number(rgb[1]) + Number(rgb[2]) + Number(rgb[3])) / 3;
	const hex = /^#([0-9a-fA-F]{6})$/.exec(color);
	if (hex) {
		const n = parseInt(hex[1], 16);
		return ((n >> 16) & 255) / 3 + ((n >> 8) & 255) / 3 + (n & 255) / 3;
	}
	return null;
}

test("浅色模式 token 为深色系、暗色模式切换为浅色系", () => {
	mockMatchMedia(false);
	useUiPrefsStore.getState().setThemeMode("light");
	render(<CodeBlockCard language="ts" code={"const a = 1;"} />);

	const lightColor = firstTokenColor();
	expect(lightColor).not.toBeNull();
	const lightBrightness = brightness(lightColor!);
	expect(lightBrightness).not.toBeNull();
	expect(lightBrightness!).toBeLessThan(150); // github 深色 token

	act(() => {
		useUiPrefsStore.getState().setThemeMode("dark");
	});
	const darkColor = firstTokenColor();
	expect(darkColor).not.toBeNull();
	const darkBrightness = brightness(darkColor!);
	expect(darkBrightness).not.toBeNull();
	expect(darkBrightness!).toBeGreaterThan(150); // nightOwl 浅色 token
	expect(darkColor).not.toBe(lightColor);
});
