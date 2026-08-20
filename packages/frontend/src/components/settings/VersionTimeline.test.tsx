import { test, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, within } from "@testing-library/react";
import { VersionTimeline } from "./VersionTimeline";
import versionHistory from "../../data/version-history.json";

beforeEach(() => cleanup());
afterEach(() => cleanup());

test("渲染时间线：最新版本默认展开，显示分类标签", () => {
	// 数据驱动：断言跟随 version-history.json 首条，发新版后不会腐坏
	const latest = versionHistory[0] as {
		version: string;
		sections: Record<string, string[]>;
	};
	const { container } = render(<VersionTimeline />);
	const timeline = within(container).getByTestId("version-timeline");
	expect(timeline).toBeTruthy();
	expect(within(timeline).getByText(`v${latest.version}`)).toBeTruthy();
	for (const category of Object.keys(latest.sections)) {
		expect(within(timeline).getByText(category)).toBeTruthy();
	}
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
	// 数据驱动：跟随 version-history.json 前三条，发新版后不会腐坏
	const latest = versionHistory[0] as { version: string };
	const second = versionHistory[1] as { version: string };
	const third = versionHistory[2] as { version: string };
	const { container } = render(<VersionTimeline maxEntries={2} />);
	const timeline = within(container).getByTestId("version-timeline");
	// 只渲染最新 2 条，其余不出现
	expect(within(timeline).getByText(`v${latest.version}`)).toBeTruthy();
	expect(within(timeline).getByText(`v${second.version}`)).toBeTruthy();
	expect(within(timeline).queryByText(`v${third.version}`)).toBeNull();
});
