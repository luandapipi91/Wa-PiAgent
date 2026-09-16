import { beforeEach, expect, test } from "bun:test";
import {
	FONT_SIZE_DEFAULT,
	FONT_SIZE_MAX,
	FONT_SIZE_MIN,
	useUiPrefsStore,
} from "../src/store/ui-prefs";

beforeEach(() => {
	localStorage.clear();
	document.documentElement.style.removeProperty("--font-scale");
	useUiPrefsStore.setState({ fontSize: FONT_SIZE_DEFAULT });
});

test("默认文字大小 16px（范围 12-32）", () => {
	expect(useUiPrefsStore.getState().fontSize).toBe(16);
	expect(FONT_SIZE_MIN).toBe(12);
	expect(FONT_SIZE_MAX).toBe(32);
});

test("setFontSize：更新状态并持久化到 localStorage", () => {
	useUiPrefsStore.getState().setFontSize(24);
	expect(useUiPrefsStore.getState().fontSize).toBe(24);
	const raw = localStorage.getItem("wa-pi-ui-prefs");
	expect(raw).toBeTruthy();
	expect(JSON.parse(raw!).state.fontSize).toBe(24);
});

test("setFontSize：写入根节点 --font-scale（24px → 1.5），不动 zoom 等布局通道", () => {
	useUiPrefsStore.getState().setFontSize(24);
	expect(
		document.documentElement.style.getPropertyValue("--font-scale"),
	).toBe("1.5");
	expect(document.documentElement.style.getPropertyValue("zoom")).toBe("");
});

test("setFontSize：越界钳制到 12-32", () => {
	useUiPrefsStore.getState().setFontSize(99);
	expect(useUiPrefsStore.getState().fontSize).toBe(FONT_SIZE_MAX);
	useUiPrefsStore.getState().setFontSize(1);
	expect(useUiPrefsStore.getState().fontSize).toBe(FONT_SIZE_MIN);
});
