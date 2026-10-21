// 任务完成青蛙动画开关：ui-prefs 持久化字段。
import { beforeEach, expect, test } from "bun:test";
import { FROG_TASK_DONE_DEFAULT, useUiPrefsStore } from "../src/store/ui-prefs";

beforeEach(() => {
	localStorage.clear();
	useUiPrefsStore.setState({ frogTaskDone: FROG_TASK_DONE_DEFAULT });
});

test("任务完成青蛙开关默认开启", () => {
	expect(FROG_TASK_DONE_DEFAULT).toBe(true);
	expect(useUiPrefsStore.getState().frogTaskDone).toBe(true);
});

test("setFrogTaskDone：更新状态并持久化到 localStorage", () => {
	useUiPrefsStore.getState().setFrogTaskDone(false);
	expect(useUiPrefsStore.getState().frogTaskDone).toBe(false);
	const raw = localStorage.getItem("wa-pi-ui-prefs");
	expect(raw).toBeTruthy();
	expect(JSON.parse(raw!).state.frogTaskDone).toBe(false);
	// 不影响相邻开关
	expect(useUiPrefsStore.getState().soundTaskDone).toBe(true);
});
