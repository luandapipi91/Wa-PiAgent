// SettingsModal 测试：验证设置弹框标题栏有显式关闭按钮（X），点击触发 onClose。
// 参照 GeneralSection.test.tsx / CommandListModal.test.tsx 风格（bun:test + RTL + happy-dom）。
import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { SettingsModal } from "./SettingsModal";
import { useUiPrefsStore } from "../store/ui-prefs";

// GeneralSection 内部走 api.get/put，happy-dom 在 about:blank 下对相对 URL 抛
// NotSupportedError，mock 掉 api-client（同 GeneralSection.test.tsx）。
const getMock = mock();
const putMock = mock();
mock.module("../api-client", () => ({
	api: {
		get: getMock,
		post: () => Promise.resolve({}),
		put: putMock,
		del: () => Promise.resolve({}),
	},
}));

beforeEach(() => {
	getMock.mockReset();
	putMock.mockReset();
	getMock.mockImplementation(async () => ({ retry: {}, trash: {} }));
	putMock.mockImplementation(async () => ({}));
	useUiPrefsStore.setState({
		exportTurns: 1,
		exportIncludeUser: false,
	});
});

test("设置弹框标题栏渲染显式关闭按钮，点击触发 onClose", async () => {
	let closed = false;
	render(
		<SettingsModal
			onClose={() => {
				closed = true;
			}}
		/>,
	);

	const closeBtn = await screen.findByTestId("settings-close");
	expect(closeBtn).toBeTruthy();

	fireEvent.click(closeBtn);
	expect(closed).toBe(true);
});
