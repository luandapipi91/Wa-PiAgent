import { test, expect, afterEach } from "bun:test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { VersionTimeline } from "./VersionTimeline";

afterEach(() => cleanup());

test("渲染时间线：最新版本默认展开，显示分类标签", () => {
	render(<VersionTimeline />);
	const timeline = screen.getByTestId("version-timeline");
	expect(timeline).toBeTruthy();
	// 最新版本（0.1.21）默认展开 → 出现分类标签「修复」
	expect(screen.getByText("修复")).toBeTruthy();
	expect(screen.getByText("v0.1.21")).toBeTruthy();
});

test("旧版本默认收起，点击版本号展开", () => {
	render(<VersionTimeline />);
	// 0.1.20 默认收起 → 其内容不可见（用 queryByText 判断）
	expect(screen.queryByText(/主会话回合看门狗/)).toBeNull();
	// 点击 v0.1.20 展开按钮
	const expandBtn = screen.getByTestId("toggle-0.1.20");
	fireEvent.click(expandBtn);
	// 展开后内容可见
	expect(screen.getByText(/主会话回合看门狗/)).toBeTruthy();
});

test("maxEntries 截断：超出部分不渲染", () => {
	render(<VersionTimeline maxEntries={2} />);
	// 只渲染最新 2 条（0.1.21 + 0.1.20），0.1.19 不出现
	expect(screen.queryByText("v0.1.19")).toBeNull();
	expect(screen.queryByText("v0.1.18")).toBeNull();
	// 0.1.21 + 0.1.20 仍然存在
	expect(screen.getByText("v0.1.21")).toBeTruthy();
	expect(screen.getByText("v0.1.20")).toBeTruthy();
});
