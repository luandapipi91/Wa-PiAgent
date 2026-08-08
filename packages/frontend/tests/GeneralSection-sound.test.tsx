import { beforeEach, expect, mock, test } from "bun:test";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const previewCalls = { taskDone: 0, needsAction: 0 };

mock.module("../src/util/sound", () => ({
	playTaskDone: () => {},
	playNeedsAction: () => {},
	previewTaskDone: () => previewCalls.taskDone++,
	previewNeedsAction: () => previewCalls.needsAction++,
	resetSoundForTests: () => {},
}));

mock.module("../src/api-client", () => ({
	api: {
		get: () => Promise.resolve({ retry: { maxRetries: 3, baseDelayMs: 2000 } }),
		post: () => Promise.resolve({}),
		put: () => Promise.resolve({}),
		del: () => Promise.resolve({}),
	},
}));

import { GeneralSection } from "../src/components/settings/GeneralSection";
import { useUiPrefsStore } from "../src/store/ui-prefs";

beforeEach(() => {
	previewCalls.taskDone = 0;
	previewCalls.needsAction = 0;
	localStorage.clear();
	useUiPrefsStore.setState({ soundTaskDone: true, soundNeedsAction: true });
});

async function renderLoaded() {
	render(<GeneralSection />);
	// 等通用设置加载完（重试输入框出现即表示 loading 结束）
	await waitFor(() => screen.getByTestId("retry-max-input"));
}

test("渲染两个提示音开关（默认开）与试听按钮", async () => {
	await renderLoaded();
	const taskDone = screen.getByTestId("sound-task-done-toggle");
	const needsAction = screen.getByTestId("sound-needs-action-toggle");
	expect(taskDone.getAttribute("data-on")).toBe("true");
	expect(needsAction.getAttribute("data-on")).toBe("true");
	expect(screen.getByTestId("sound-task-done-preview")).toBeTruthy();
	expect(screen.getByTestId("sound-needs-action-preview")).toBeTruthy();
});

test("切换任务完成开关：即时写入 store 并持久化，无需点保存", async () => {
	await renderLoaded();
	fireEvent.click(screen.getByTestId("sound-task-done-toggle"));
	expect(useUiPrefsStore.getState().soundTaskDone).toBe(false);
	expect(
		screen.getByTestId("sound-task-done-toggle").getAttribute("data-on"),
	).toBe("false");
	const raw = localStorage.getItem("wa-pi-ui-prefs");
	expect(JSON.parse(raw!).state.soundTaskDone).toBe(false);
	// 另一个开关不受影响
	expect(useUiPrefsStore.getState().soundNeedsAction).toBe(true);
});

test("切换需要操作开关：即时写入 store", async () => {
	await renderLoaded();
	fireEvent.click(screen.getByTestId("sound-needs-action-toggle"));
	expect(useUiPrefsStore.getState().soundNeedsAction).toBe(false);
	expect(
		screen.getByTestId("sound-needs-action-toggle").getAttribute("data-on"),
	).toBe("false");
	expect(useUiPrefsStore.getState().soundTaskDone).toBe(true);
});

test("点试听按钮调用对应 preview（开关关着也能试听）", async () => {
	useUiPrefsStore.setState({ soundTaskDone: false, soundNeedsAction: false });
	await renderLoaded();
	fireEvent.click(screen.getByTestId("sound-task-done-preview"));
	fireEvent.click(screen.getByTestId("sound-needs-action-preview"));
	expect(previewCalls.taskDone).toBe(1);
	expect(previewCalls.needsAction).toBe(1);
});
