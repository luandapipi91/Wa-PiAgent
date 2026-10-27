// AppearanceSection 设置面板测试：
// 1. 语言选择即时生效：select 改变 → setLanguage 写 ui-prefs + 双写 PUT /api/settings/language
//    （语言区块自通用 tab 移入外观 tab，交互与外观页一致改为即时生效）
// 2. 任务完成通知开关渲染与切换
import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { AppearanceSection } from "./AppearanceSection";
import { useUiPrefsStore } from "../../store/ui-prefs";

const putMock = mock();
mock.module("../../api-client", () => ({
	api: {
		get: () => Promise.resolve({}),
		post: () => Promise.resolve({}),
		put: putMock,
		del: () => Promise.resolve({}),
	},
}));

beforeEach(() => {
	putMock.mockReset();
	putMock.mockImplementation(async () => ({}));
	useUiPrefsStore.setState({
		language: "zh",
		noticeTaskDone: true,
	});
});

test("语言选择即时生效：select 改变 → setLanguage + 双写 PUT /api/settings/language", async () => {
	render(<AppearanceSection />);
	const select = screen.getByTestId("language-select");
	expect((select as HTMLSelectElement).value).toBe("zh");

	fireEvent.change(select, { target: { value: "en" } });
	// 即时生效：ui-prefs 立即写入（无草稿/保存按钮）
	expect(useUiPrefsStore.getState().language).toBe("en");
	await new Promise((r) => setTimeout(r, 10));
	// 双写 kernel settings.json（后端 i18n 基建）
	expect(putMock).toHaveBeenCalledWith("/api/settings/language", {
		language: "en",
	});
});

test("任务完成通知开关：渲染并切换写 ui-prefs", () => {
	render(<AppearanceSection />);
	const toggle = screen.getByTestId("notice-task-done-toggle");
	expect(toggle.getAttribute("data-on")).toBe("true");
	fireEvent.click(toggle);
	expect(useUiPrefsStore.getState().noticeTaskDone).toBe(false);
	expect(toggle.getAttribute("data-on")).toBe("false");
});
