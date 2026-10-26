// 系统通知模块单测：isBackgrounded 前台判定 + setupNotice 的 notice:send IPC 契约。
// ipcMain/Notification 用 fake 注入（同 native-dialogs.test.ts 的做法），不依赖 Electron 环境。
import { test, expect } from "bun:test";
import { isBackgrounded, setupNotice } from "../src/notice/notice.cjs";

const win = (state: { isMinimized: boolean; isFocused: boolean }) => ({
	isMinimized: () => state.isMinimized,
	isFocused: () => state.isFocused,
});

function makeHarness({ supported = true } = {}) {
	const handlers = new Map<string, (...args: any[]) => any>();
	const notifications: any[] = [];

	class Notification {
		options: any;
		shown = false;
		listeners = new Map<string, (() => void)[]>();
		constructor(options: any) {
			this.options = options;
			notifications.push(this);
		}
		on(event: string, cb: () => void) {
			const arr = this.listeners.get(event) ?? [];
			arr.push(cb);
			this.listeners.set(event, arr);
		}
		show() {
			this.shown = true;
		}
		emit(event: string) {
			for (const cb of this.listeners.get(event) ?? []) cb();
		}
		static isSupported() {
			return supported;
		}
	}

	const ipcMain = {
		handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn),
	};

	const sent: Array<[string, any]> = [];
	// 默认前台聚焦（后台用例里再覆盖）
	const mainWindow: any = {
		isDestroyed: () => false,
		isMinimized: () => false,
		isFocused: () => true,
		webContents: {
			send: (channel: string, payload: any) => sent.push([channel, payload]),
		},
	};

	let activateCalls = 0;
	setupNotice({
		getMainWindow: () => mainWindow,
		activateApp: () => {
			activateCalls++;
		},
		ipcMain,
		Notification: Notification as any,
	});

	return {
		handlers,
		notifications,
		sent,
		mainWindow,
		getActivateCalls: () => activateCalls,
	};
}

const send = (h: ReturnType<typeof makeHarness>, payload: any) =>
	h.handlers.get("notice:send")!({}, payload);

test("isBackgrounded：最小化 → true", () => {
	expect(isBackgrounded(win({ isMinimized: true, isFocused: false }))).toBe(true);
});

test("isBackgrounded：未聚焦 → true", () => {
	expect(isBackgrounded(win({ isMinimized: false, isFocused: false }))).toBe(true);
});

test("isBackgrounded：前台聚焦 → false", () => {
	expect(isBackgrounded(win({ isMinimized: false, isFocused: true }))).toBe(false);
});

test('backgroundOnly 且前台 → 返回 {sent:false, reason:"foreground"}，不 new Notification', async () => {
	const h = makeHarness();
	const result = await send(h, {
		title: "t",
		body: "b",
		action: { a: 1 },
		backgroundOnly: true,
	});
	expect(result).toEqual({ sent: false, reason: "foreground" });
	expect(h.notifications.length).toBe(0);
});

test("后台 → new Notification(title, { body, silent: true }) 并 show()，返回 {sent:true}", async () => {
	const h = makeHarness();
	h.mainWindow.isMinimized = () => true; // 后台：最小化
	h.mainWindow.isFocused = () => false;
	const result = await send(h, {
		title: "任务完成",
		body: "已生成",
		action: { a: 1 },
		backgroundOnly: true,
	});
	expect(result).toEqual({ sent: true });
	expect(h.notifications.length).toBe(1);
	expect(h.notifications[0].options).toEqual({
		title: "任务完成",
		body: "已生成",
		silent: true,
	});
	expect(h.notifications[0].shown).toBe(true);
});

test('Notification.isSupported() 为 false → {sent:false, reason:"unsupported"}', async () => {
	const h = makeHarness({ supported: false });
	const result = await send(h, { title: "t", body: "b", action: {} });
	expect(result).toEqual({ sent: false, reason: "unsupported" });
	expect(h.notifications.length).toBe(0);
});

test('通知 click 事件触发 → activateApp() 被调 + getMainWindow().webContents.send("notice:action", action) 收到原始 action 载荷', async () => {
	const h = makeHarness();
	const action = { kind: "open-session", sessionId: "s1" };
	await send(h, { title: "t", body: "b", action });
	h.notifications[0].emit("click");
	expect(h.getActivateCalls()).toBe(1);
	expect(h.sent).toEqual([["notice:action", action]]);
});

test("非 backgroundOnly（场景②）前台 → 照发", async () => {
	const h = makeHarness(); // mainWindow 默认前台聚焦
	const result = await send(h, { title: "t", body: "b", action: {} });
	expect(result).toEqual({ sent: true });
	expect(h.notifications.length).toBe(1);
	expect(h.notifications[0].options.silent).toBe(true);
});
