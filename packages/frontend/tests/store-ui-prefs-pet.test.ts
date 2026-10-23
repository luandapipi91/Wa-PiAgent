// 桌面宠物开关：ui-prefs 持久化字段 + 与主进程的实时同步。
import { beforeEach, expect, test } from "bun:test";
import {
	DESKTOP_PET_DEFAULT,
	useUiPrefsStore,
} from "../src/store/ui-prefs";

const calls: Array<[string, boolean]> = [];

beforeEach(() => {
	localStorage.clear();
	calls.length = 0;
	(window as any).waPiPet = {
		setEnabled: (v: boolean) => calls.push(["setEnabled", v]),
		celebrate: () => {},
		onEvent: () => () => {},
	};
	useUiPrefsStore.setState({
		desktopPet: DESKTOP_PET_DEFAULT,
		frogTaskDone: true,
		themeMode: "system",
		themeColor: "green",
		fontSize: 16,
	});
});

test("桌面宠物默认开启", () => {
	expect(DESKTOP_PET_DEFAULT).toBe(true);
	expect(useUiPrefsStore.getState().desktopPet).toBe(true);
});

test("setDesktopPet：更新状态、持久化 localStorage，并同步主进程建/销窗", () => {
	useUiPrefsStore.getState().setDesktopPet(false);
	expect(useUiPrefsStore.getState().desktopPet).toBe(false);
	const raw = localStorage.getItem("wa-pi-ui-prefs");
	expect(raw).toBeTruthy();
	expect(JSON.parse(raw!).state.desktopPet).toBe(false);
	expect(calls).toContainEqual(["setEnabled", false]);
	// 不影响相邻开关
	expect(useUiPrefsStore.getState().frogTaskDone).toBe(true);
});

test("localStorage 恢复（旧数据缺字段）→ 取默认开启并同步主进程", async () => {
	localStorage.setItem(
		"wa-pi-ui-prefs",
		JSON.stringify({ state: { frogTaskDone: false }, version: 0 }),
	);
	// 触发重新水合
	await useUiPrefsStore.persist.rehydrate();
	expect(useUiPrefsStore.getState().desktopPet).toBe(true);
	expect(useUiPrefsStore.getState().frogTaskDone).toBe(false);
	expect(calls).toContainEqual(["setEnabled", true]);
});
