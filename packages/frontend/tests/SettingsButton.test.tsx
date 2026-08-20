import { test, expect, afterEach } from "bun:test";
import { render, screen, cleanup } from "@testing-library/react";
import { SettingsButton } from "../src/components/SettingsButton";

afterEach(() => {
	cleanup();
});

test("系统设置图标基础尺寸 18px 且随 --font-scale 缩放", () => {
	render(<SettingsButton onClick={() => {}} />);
	const icon = screen.getByTestId("settings-btn").querySelector("svg");
	expect(icon).toBeTruthy();
	// 尺寸用 em：相对自身 font-size（基础 18px × var(--font-scale)），字体缩放时图标同步缩放
	expect(icon!.getAttribute("width")).toBe("1em");
	expect(icon!.getAttribute("height")).toBe("1em");
	expect(icon!.getAttribute("class")).toContain(
		"text-[calc(18px*var(--font-scale))]",
	);
});

test("窄侧栏时文字可收缩（truncate + shrink），图标固定不换行", () => {
	render(<SettingsButton onClick={() => {}} />);
	const btn = screen.getByTestId("settings-btn");
	// 按钮：flex + min-w-0 + overflow-hidden，文字 span 可收缩截断
	expect(btn.className).toContain("flex");
	expect(btn.className).toContain("min-w-0");
	expect(btn.className).toContain("overflow-hidden");
	const text = btn.querySelector("span");
	expect(text!.className).toContain("whitespace-nowrap");
	expect(text!.className).toContain("truncate");
	expect(text!.className).toContain("shrink");
	// 图标 flex-shrink-0：窄宽度时优先保留 icon
	const icon = btn.querySelector("svg")!;
	expect(icon.getAttribute("class")).toContain("flex-shrink-0");
});
