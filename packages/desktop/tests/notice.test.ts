// 通知发送层单测：isBackgrounded 前台判定 + setupNotice 的 notice:send IPC 契约与卡片链路
// （入队合并 / 卡片事件 / 倒计时暂停恢复重置 / 窗口销毁重建）。
// Electron 组件用 fake 注入（同 notice-card-window.test.ts 的做法），不依赖 Electron 环境；
// 倒计时经注入 fake timer 驱动（setupNotice 可注入 timer，默认 setTimeout/Date.now）。
import { test, expect } from "bun:test";
import { isBackgrounded, setupNotice } from "../src/notice/notice.cjs";

const win = (state: { isMinimized: boolean; isFocused: boolean }) => ({
	isMinimized: () => state.isMinimized,
	isFocused: () => state.isFocused,
});

/** 单槽 fake timer：同一时刻至多一个倒计时在跑；advance 推进时钟并在到期时同步触发回调 */
function makeFakeTimer() {
	let now = 0;
	let pending: { fn: () => void; at: number } | null = null;
	return {
		now: () => now,
		set: (fn: () => void, ms: number) => {
			pending = { fn, at: now + ms };
			return pending;
		},
		clear: (_id: unknown) => {
			pending = null;
		},
		advance: (ms: number) => {
			now += ms;
			if (pending && now >= pending.at) {
				const fn = pending.fn;
				pending = null;
				fn();
			}
		},
	};
}

function makeHarness() {
	const handlers = new Map<string, (...args: any[]) => any>();
	const listeners = new Map<string, (...args: any[]) => any>();
	const timer = makeFakeTimer();
	const loadCbs: Array<() => void> = [];
	const hides: number[] = []; // 收到 hide() 的窗口序号（created 下标，可重复）
	const cardDownlink: any[] = []; // 卡片窗口收到的 notice-card:update 载荷
	const sentToMain: Array<[string, any]> = []; // 主窗口收到的下行（notice:action）

	class FakeWindow {
		options: any;
		webContents = {
			send: (channel: string, payload: any) => {
				if (channel === "notice-card:update") cardDownlink.push(payload);
			},
			once: (_event: string, cb: () => void) => loadCbs.push(cb),
		};
		destroyed = false;
		constructor(options: any) {
			this.options = options;
		}
		on(_event: string, _cb: (...args: any[]) => void) {}
		loadFile(_p: string) {}
		setBounds(_b: any) {}
		showInactive() {}
		hide() {
			hides.push(created.indexOf(this));
		}
		destroy() {
			this.destroyed = true;
		}
		isDestroyed() {
			return this.destroyed;
		}
	}

	const created: FakeWindow[] = [];
	const BrowserWindow: any = function (options: any) {
		const w = new FakeWindow(options);
		created.push(w);
		return w;
	};

	const ipcMain = {
		handle: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn),
		on: (name: string, fn: (...args: any[]) => any) => listeners.set(name, fn),
	};

	// 默认前台聚焦（后台用例里再覆盖）
	const mainWindow: any = {
		isDestroyed: () => false,
		isMinimized: () => false,
		isFocused: () => true,
		webContents: {
			send: (channel: string, payload: any) => sentToMain.push([channel, payload]),
		},
	};

	let activateCalls = 0;
	setupNotice({
		getMainWindow: () => mainWindow,
		activateApp: () => {
			activateCalls++;
		},
		ipcMain: ipcMain as any, // mock 不实现完整 electron.IpcMain（照 pet-window.test.ts 先例）
		BrowserWindow,
		getPrimaryDisplay: (() => ({
			workArea: { x: 0, y: 0, width: 1920, height: 1080 },
		})) as any,
		timer,
	});

	// 触发卡片窗口 did-finish-load（mock 里 once 存下的回调；旧窗回调由模块内 w !== win 守卫跳过）
	const fireLoad = () => loadCbs.splice(0).forEach((cb) => cb());
	// 以卡片窗口 sender 触发 notice-card:event（默认最新窗口）
	const fireCardEvent = (evt: any) =>
		listeners.get("notice-card:event")!(
			{ sender: created[created.length - 1].webContents },
			evt,
		);
	// 最近一次下行到卡片的载荷
	const lastUpdate = () => cardDownlink[cardDownlink.length - 1];

	return {
		handlers,
		listeners,
		timer,
		created,
		hides,
		cardDownlink,
		sentToMain,
		mainWindow,
		fireLoad,
		fireCardEvent,
		lastUpdate,
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

test('notice:send：title 非字符串（防御）→ {sent:false, reason:"invalid"}，不入队不显示', () => {
	const h = makeHarness();
	expect(send(h, { title: 123, body: "b", action: {} })).toEqual({
		sent: false,
		reason: "invalid",
	});
	expect(send(h, undefined)).toEqual({ sent: false, reason: "invalid" });
	expect(h.created.length).toBe(0);
	expect(h.cardDownlink.length).toBe(0);
});

test('notice:send：backgroundOnly 且前台 → 不入队不显示，返回 {sent:false, reason:"foreground"}', () => {
	const h = makeHarness(); // mainWindow 默认前台聚焦
	const result = send(h, {
		title: "t",
		body: "b",
		action: { a: 1 },
		backgroundOnly: true,
	});
	expect(result).toEqual({ sent: false, reason: "foreground" });
	expect(h.created.length).toBe(0); // 没建卡片窗口
	expect(h.cardDownlink.length).toBe(0); // 没有下行载荷
});

test("notice:send：后台 → 入队 + 卡片下行载荷（items/index/theme/count）+ 返回 {sent:true}", () => {
	const h = makeHarness();
	h.mainWindow.isMinimized = () => true; // 后台：最小化
	h.mainWindow.isFocused = () => false;
	const action = { type: "session", sessionId: "s1" };
	const result = send(h, {
		title: "任务完成",
		body: "已生成",
		action,
		theme: "dark",
		backgroundOnly: true,
	});
	expect(result).toEqual({ sent: true });
	h.fireLoad(); // 页面就绪后补发最新载荷
	expect(h.lastUpdate()).toEqual({
		items: [{ title: "任务完成", body: "已生成", action, sessionId: "session:s1" }],
		index: 0,
		theme: "dark",
		count: 1,
	});
	expect(h.hides.length).toBe(0);
});

test("notice:send：非 backgroundOnly → 跳过前台判定直接入队显示", () => {
	const h = makeHarness(); // mainWindow 默认前台聚焦
	const result = send(h, { title: "t", body: "b", action: { type: "update" } });
	expect(result).toEqual({ sent: true });
	h.fireLoad();
	expect(h.lastUpdate().count).toBe(1);
});

test("notice:send：同 sessionId 二次发送 → 队列条数不变（合并）+ showCard 重置（index 指向该条）", () => {
	const h = makeHarness();
	const action = { type: "session", sessionId: "s1" };
	send(h, { title: "t1", body: "第一轮", action });
	h.fireLoad();
	send(h, { title: "t2", body: "第二轮", action }); // 页面已就绪：直接下行
	expect(h.cardDownlink.length).toBe(2);
	const payload = h.lastUpdate();
	expect(payload.items.length).toBe(1); // 合并：仍只有一条
	expect(payload.count).toBe(1);
	expect(payload.index).toBe(0); // index 指向该条
	expect(payload.items[0].body).toBe("第二轮"); // 刷新为最新内容
});

test("notice:send：update 类型 action 也按稳定键合并（同类只留最新一条）", () => {
	const h = makeHarness();
	send(h, { title: "v1", body: "旧版本提醒", action: { type: "update" } });
	send(h, { title: "v2", body: "新版本提醒", action: { type: "update" } });
	h.fireLoad();
	expect(h.lastUpdate().items.length).toBe(1);
	expect(h.lastUpdate().items[0].title).toBe("v2");
});

test("卡片 card:click → action 原样透传（notice:action 下行）+ removeCurrent + 队列空时 hide()", () => {
	const h = makeHarness();
	const action = { type: "session", sessionId: "s1", path: "/sessions/s1" };
	send(h, { title: "t", body: "b", action });
	h.fireLoad();
	h.fireCardEvent({ type: "card:click" });
	expect(h.sentToMain).toEqual([["notice:action", action]]); // 原 action 载荷透传
	expect(h.getActivateCalls()).toBe(1); // controller 内部已激活应用
	expect(h.hides.length).toBe(1); // 队列空 → 关卡片
	// 队列已清空（showCard 收到的 items 是队列数组引用，clear 为原地清空）
	expect(h.lastUpdate().items.length).toBe(0);
});

test("卡片 card:click → 队列非空时移除当前条并刷新显示下一条", () => {
	const h = makeHarness();
	send(h, { title: "A", body: "a", action: { type: "session", sessionId: "s1" } });
	send(h, { title: "B", body: "b", action: { type: "session", sessionId: "s2" } });
	h.fireLoad(); // 下行 {items:[A,B], index:1}
	h.fireCardEvent({ type: "card:click" }); // 点掉 B（当前条）
	const payload = h.lastUpdate();
	expect(payload.items.length).toBe(1); // 移除后剩 A
	expect(payload.items[0].title).toBe("A");
	expect(payload.index).toBe(0);
	expect(payload.count).toBe(1);
	expect(h.hides.length).toBe(0); // 队列非空 → 不关卡片
});

test("卡片 card:click → 队列非空时重置倒计时：运行态（fake timer）", () => {
	const h = makeHarness();
	send(h, { title: "A", body: "a", action: { type: "session", sessionId: "s1" } });
	send(h, { title: "B", body: "b", action: { type: "session", sessionId: "s2" } });
	h.fireLoad();
	h.timer.advance(3000); // 已走 3s
	h.fireCardEvent({ type: "card:click" }); // 移除 B 刷新 → 重置倒计时
	h.timer.advance(4999); // 重置后 at=8000、now=7999；未重置实现 at=5000 此刻已触发（有区分力）
	expect(h.hides.length).toBe(0);
	h.timer.advance(1); // now=8000 → 到期
	expect(h.hides.length).toBe(1);
	expect(h.lastUpdate().items.length).toBe(0);
});

test("卡片 card:click → 暂停态下重置为满额暂停且不启动计时（fake timer）", () => {
	const h = makeHarness();
	send(h, { title: "A", body: "a", action: { type: "session", sessionId: "s1" } });
	send(h, { title: "B", body: "b", action: { type: "session", sessionId: "s2" } });
	h.fireLoad();
	h.timer.advance(3000); // 已走 3s
	h.fireCardEvent({ type: "card:hover", action: "pause" }); // 暂停（剩余 2s）
	h.fireCardEvent({ type: "card:click" }); // 悬停中点击 → 重置为满额暂停（5s）、不设 timer
	h.timer.advance(10000); // 保持暂停：多久都不该触发
	expect(h.hides.length).toBe(0);
	h.fireCardEvent({ type: "card:hover", action: "resume" }); // 从满额 5s 续跑
	h.timer.advance(4999); // 未重置为满额的实现（剩余 2s）此刻早已触发
	expect(h.hides.length).toBe(0);
	h.timer.advance(1); // 满额 5s 走完 → 到期
	expect(h.hides.length).toBe(1);
});

test("卡片 card:hover pause/resume → 倒计时暂停/恢复（注入 fake timer 断言）", () => {
	const h = makeHarness();
	send(h, { title: "t", body: "b", action: { type: "update" } });
	h.fireLoad();
	h.timer.advance(3000); // 已走 3s
	h.fireCardEvent({ type: "card:hover", action: "pause" });
	h.timer.advance(10000); // 暂停期间推进多久都不该到期
	expect(h.hides.length).toBe(0);
	h.fireCardEvent({ type: "card:hover", action: "resume" });
	h.timer.advance(1999); // 剩余 2s：还差 1ms
	expect(h.hides.length).toBe(0);
	h.timer.advance(1); // 剩余时间走满 → 到期
	expect(h.hides.length).toBe(1);
	expect(h.lastUpdate().items.length).toBe(0); // 队列清空
});

test("倒计时 5s 到期（fake timer）→ hide() + 队列清空", () => {
	const h = makeHarness();
	send(h, { title: "t", body: "b", action: { type: "update" } });
	h.fireLoad();
	h.timer.advance(4999);
	expect(h.hides.length).toBe(0);
	h.timer.advance(1); // 5000ms 整 → 到期
	expect(h.hides.length).toBe(1);
	expect(h.lastUpdate().items.length).toBe(0);
});

test("卡片 card:switch → queue.next/prev 刷新 + 倒计时重置（fake timer）", () => {
	const h = makeHarness();
	send(h, { title: "A", body: "a", action: { type: "session", sessionId: "s1" } });
	send(h, { title: "B", body: "b", action: { type: "session", sessionId: "s2" } });
	h.fireLoad(); // 下行 {items:[A,B], index:1}
	h.timer.advance(3000); // 已走 3s
	h.fireCardEvent({ type: "card:switch", dir: "next" }); // 1 → 0（循环）
	expect(h.lastUpdate().index).toBe(0); // 切换后刷新
	h.timer.advance(4999); // 重置后 at=8000、now=7999 未到期；未重置实现 at=5000 此刻已触发（有区分力）
	expect(h.hides.length).toBe(0);
	h.timer.advance(1); // now=8000 → 重置后 5s 走满
	expect(h.hides.length).toBe(1);
});

test("卡片窗口销毁后再次 notice:send → 不抛错，重建窗口成功", () => {
	const h = makeHarness();
	send(h, { title: "t1", body: "b1", action: { type: "update" } });
	h.fireLoad();
	h.created[0].destroy(); // 模拟窗口被销毁（页面加载失败同理：下次 showCard 走重建）
	let result: any;
	expect(() => {
		result = send(h, { title: "t2", body: "b2", action: { type: "update" } });
	}).not.toThrow();
	expect(result).toEqual({ sent: true });
	expect(h.created.length).toBe(2); // 重建了新窗口
	h.fireLoad(); // 新窗口页面就绪 → 补发
	const payload = h.lastUpdate();
	expect(payload.items.length).toBe(1);
	expect(payload.items[0].title).toBe("t2");
	expect(payload.index).toBe(0);
});
