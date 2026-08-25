import { beforeEach, expect, test } from "bun:test";
import {
	COLLAPSE_PROCESS_DEFAULT,
	useUiPrefsStore,
} from "../src/store/ui-prefs";

beforeEach(() => {
	localStorage.clear();
	useUiPrefsStore.setState({
		collapseProcessByDefault: COLLAPSE_PROCESS_DEFAULT,
	});
});

test("回复过程默认折叠开关默认为 true（默认不展开工具调用和思维链）", () => {
	expect(COLLAPSE_PROCESS_DEFAULT).toBe(true);
	expect(useUiPrefsStore.getState().collapseProcessByDefault).toBe(true);
});

test("setCollapseProcessByDefault：更新状态并持久化到 localStorage", () => {
	useUiPrefsStore.getState().setCollapseProcessByDefault(false);
	expect(useUiPrefsStore.getState().collapseProcessByDefault).toBe(false);
	const raw = localStorage.getItem("wa-pi-ui-prefs");
	expect(raw).toBeTruthy();
	expect(JSON.parse(raw!).state.collapseProcessByDefault).toBe(false);
});

test("setCollapseProcessByDefault(true)：切回展开（现状）", () => {
	useUiPrefsStore.getState().setCollapseProcessByDefault(true);
	expect(useUiPrefsStore.getState().collapseProcessByDefault).toBe(true);
});
