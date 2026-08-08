import { beforeEach, expect, test } from "bun:test";
import {
	SOUND_NEEDS_ACTION_DEFAULT,
	SOUND_TASK_DONE_DEFAULT,
	useUiPrefsStore,
} from "../src/store/ui-prefs";

beforeEach(() => {
	localStorage.clear();
	useUiPrefsStore.setState({
		soundTaskDone: SOUND_TASK_DONE_DEFAULT,
		soundNeedsAction: SOUND_NEEDS_ACTION_DEFAULT,
	});
});

test("提示音开关默认均为 true", () => {
	expect(SOUND_TASK_DONE_DEFAULT).toBe(true);
	expect(SOUND_NEEDS_ACTION_DEFAULT).toBe(true);
	expect(useUiPrefsStore.getState().soundTaskDone).toBe(true);
	expect(useUiPrefsStore.getState().soundNeedsAction).toBe(true);
});

test("setSoundTaskDone：更新状态并持久化到 localStorage", () => {
	useUiPrefsStore.getState().setSoundTaskDone(false);
	expect(useUiPrefsStore.getState().soundTaskDone).toBe(false);
	const raw = localStorage.getItem("wa-pi-ui-prefs");
	expect(raw).toBeTruthy();
	expect(JSON.parse(raw!).state.soundTaskDone).toBe(false);
	// 不影响另一个开关
	expect(useUiPrefsStore.getState().soundNeedsAction).toBe(true);
});

test("setSoundNeedsAction：更新状态并持久化到 localStorage", () => {
	useUiPrefsStore.getState().setSoundNeedsAction(false);
	expect(useUiPrefsStore.getState().soundNeedsAction).toBe(false);
	const raw = localStorage.getItem("wa-pi-ui-prefs");
	expect(JSON.parse(raw!).state.soundNeedsAction).toBe(false);
	expect(useUiPrefsStore.getState().soundTaskDone).toBe(true);
});
