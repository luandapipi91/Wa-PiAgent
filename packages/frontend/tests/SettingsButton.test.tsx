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
