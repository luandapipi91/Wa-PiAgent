import { beforeEach, expect, test } from "bun:test";
import { useUiPrefsStore } from "../src/store/ui-prefs";
import i18n from "i18next";

/**
 * setLanguage 是语言切换的核心：更新 store + 持久化到 localStorage +
 * 同步 i18n 实例语言 + 同步 <html lang>。
 * i18n 已由 happydom-setup 初始化为 zh。
 */
const UI_PREFS_KEY = "wa-pi-ui-prefs";

beforeEach(() => {
	localStorage.clear();
	useUiPrefsStore.setState({ language: "zh", fontSize: 16, exportTurns: 1 });
});

test("默认语言为 zh", () => {
	expect(useUiPrefsStore.getState().language).toBe("zh");
});

test("setLanguage('en')：更新 store 状态", () => {
	useUiPrefsStore.getState().setLanguage("en");
	expect(useUiPrefsStore.getState().language).toBe("en");
});

test("setLanguage：持久化 language 字段到 localStorage（zustand persist 格式）", () => {
	useUiPrefsStore.getState().setLanguage("en");
	const raw = localStorage.getItem(UI_PREFS_KEY);
	expect(raw).toBeTruthy();
	expect(JSON.parse(raw!).state.language).toBe("en");
});

test("setLanguage('en')：同步 i18n 实例语言为 en", async () => {
	useUiPrefsStore.getState().setLanguage("en");
	// changeLanguage 是异步的，等一个微任务让副作用落地
	await Promise.resolve();
	expect(i18n.language).toBe("en");
});

test("setLanguage：同步 <html lang> 属性", () => {
	useUiPrefsStore.getState().setLanguage("en");
	expect(document.documentElement.lang).toBe("en");
	useUiPrefsStore.getState().setLanguage("zh");
	expect(document.documentElement.lang).toBe("zh");
});

test("setLanguage：切换回中文恢复 i18n 语言", async () => {
	useUiPrefsStore.getState().setLanguage("en");
	await Promise.resolve();
	useUiPrefsStore.getState().setLanguage("zh");
	await Promise.resolve();
	expect(i18n.language).toBe("zh");
});
