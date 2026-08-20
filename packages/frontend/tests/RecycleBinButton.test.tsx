import { test, expect, afterEach } from "bun:test";
import { render, screen, cleanup } from "@testing-library/react";
import { RecycleBinButton } from "../src/components/RecycleBinButton";

afterEach(() => {
	cleanup();
});

test("正常显示回收站文字", () => {
	render(<RecycleBinButton onClick={() => {}} />);
	expect(screen.getByTestId("recycle-bin-btn").textContent).toContain(
		"回收站",
	);
});

test("compact 模式：隐藏文字只保留图标", () => {
	render(<RecycleBinButton onClick={() => {}} compact />);
	const btn = screen.getByTestId("recycle-bin-btn");
	// 文字 span 不渲染，仅 icon 保留
	expect(btn.querySelector("span")).toBeNull();
	expect(btn.querySelector("svg")).toBeTruthy();
	expect(btn.textContent).toBe("");
});

test("compact 模式仍显示未读角标", () => {
	render(<RecycleBinButton onClick={() => {}} count={5} compact />);
	expect(screen.getByTestId("recycle-bin-badge")).toBeTruthy();
	expect(screen.getByTestId("recycle-bin-badge").textContent).toBe("5");
});

test("compact=false 正常显示文字与角标", () => {
	render(<RecycleBinButton onClick={() => {}} count={5} compact={false} />);
	expect(screen.getByTestId("recycle-bin-btn").textContent).toContain(
		"回收站",
	);
	expect(screen.getByTestId("recycle-bin-badge").textContent).toBe("5");
});
