import { test, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, within } from "@testing-library/react";
import { VersionTimeline } from "./VersionTimeline";

beforeEach(() => cleanup());
afterEach(() => cleanup());

test("渲染时间线：最新版本默认展开，显示分类标签", () => {
	const { container } = render(<VersionTimeline />);
	const timeline = within(container).getByTestId("version-timeline");
	expect(timeline).toBeTruthy();
	expect(within(timeline).getByText("修复")).toBeTruthy();
	expect(within(timeline).getByText("v0.1.21")).toBeTruthy();
});

test("旧版本默认收起，点击版本号展开", () => {
	const { container } = render(<VersionTimeline />);
	const timeline = within(container).getByTestId("version-timeline");
	expect(within(timeline).queryByText(/主会话回合看门狗/)).toBeNull();
	const expandBtn = within(timeline).getByTestId("toggle-0.1.20");
	fireEvent.click(expandBtn);
	expect(within(timeline).getByText(/主会话回合看门狗/)).toBeTruthy();
});

test("maxEntries 截断：超出部分不渲染", () => {
	const { container } = render(<VersionTimeline maxEntries={2} />);
	const timeline = within(container).getByTestId("version-timeline");
	// 只渲染最新 2 条（0.1.26 + 0.1.24），其余不出现（数据已推进，断言跟随当前 version-history.json）
	expect(within(timeline).queryByText("v0.1.23")).toBeNull();
	expect(within(timeline).queryByText("v0.1.22")).toBeNull();
	expect(within(timeline).getByText("v0.1.26")).toBeTruthy();
	expect(within(timeline).getByText("v0.1.24")).toBeTruthy();
});
