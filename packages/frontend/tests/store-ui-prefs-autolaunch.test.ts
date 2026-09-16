import { beforeEach, expect, test } from "bun:test";
import { AUTO_LAUNCH_DEFAULT, useUiPrefsStore } from "../src/store/ui-prefs";

beforeEach(() => {
	localStorage.clear();
	useUiPrefsStore.setState({
		autoLaunch: AUTO_LAUNCH_DEFAULT,
	});
});

test("开机自启默认为 true（安装后默认开启）", () => {
	expect(AUTO_LAUNCH_DEFAULT).toBe(true);
	expect(useUiPrefsStore.getState().autoLaunch).toBe(true);
});

test("setAutoLaunch：更新状态并持久化到 localStorage", () => {
	useUiPrefsStore.getState().setAutoLaunch(false);
	expect(useUiPrefsStore.getState().autoLaunch).toBe(false);
	const raw = localStorage.getItem("wa-pi-ui-prefs");
	expect(raw).toBeTruthy();
	expect(JSON.parse(raw!).state.autoLaunch).toBe(false);
});
