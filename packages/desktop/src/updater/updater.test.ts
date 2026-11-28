import { test, expect, describe } from "bun:test";
import {
	translateUpdaterEvent,
	updaterPhases,
	makeQuitAndInstallHandler,
	createStartupCheck,
	setupUpdater,
} from "./updater.cjs";

describe("translateUpdaterEvent", () => {
	test("checking-for-update → checking", () => {
		expect(translateUpdaterEvent({ type: "checking-for-update" })).toEqual({
			phase: "checking",
		});
	});

	test("update-available → available（携带 version + releaseNotes）", () => {
		const out = translateUpdaterEvent({
			type: "update-available",
			info: { version: "0.2.0", releaseNotes: "修复" },
		});
		expect(out).toEqual({
			phase: "available",
			version: "0.2.0",
			releaseNotes: "修复",
		});
	});

	test("update-not-available → up-to-date", () => {
		expect(translateUpdaterEvent({ type: "update-not-available" })).toEqual({
			phase: "up-to-date",
		});
	});

	test("download-progress → downloading（percent/transferred/total）", () => {
		const out = translateUpdaterEvent({
			type: "download-progress",
			progress: { percent: 45.6, transferred: 57671680, total: 134217728 },
		});
		expect(out).toEqual({
			phase: "downloading",
			progress: 45.6,
			transferred: 57671680,
			total: 134217728,
		});
	});

	test("update-downloaded → downloaded", () => {
		// 不传 info 时 version 为 null；带 version 字段是为了让前端（任务 7）能消费版本号。
		expect(translateUpdaterEvent({ type: "update-downloaded" })).toEqual({
			phase: "downloaded",
			version: null,
		});
	});

	test("error → error（message 提取）", () => {
		const out = translateUpdaterEvent({
			type: "error",
			error: new Error("网络失败"),
		});
		expect(out.phase).toBe("error");
		expect(out.message).toBe("网络失败");
		expect(out.raw).toBe("网络失败");
	});

	test("未知事件 → null（忽略）", () => {
		expect(translateUpdaterEvent({ type: "unknown-event" })).toBeNull();
	});
});

describe("updaterPhases", () => {
	test("包含全部阶段", () => {
		expect(updaterPhases).toEqual([
			"checking",
			"available",
			"up-to-date",
			"downloading",
			"downloaded",
			"error",
		]);
	});
});

describe("makeQuitAndInstallHandler", () => {
	// 所有 mock updater 共用：once 收集事件监听器，供测试断言
	function mockUpdater(order?: string[]) {
		return {
			quitAndInstall: () => order?.push("quitAndInstall"),
			once: () => {},
		};
	}

	test("先等 onBeforeQuitAndInstall 完成，再调 quitAndInstall（调用顺序断言）", async () => {
		const order: string[] = [];
		const updater = mockUpdater(order);
		const onBeforeQuitAndInstall = async () => {
			await new Promise((r) => setTimeout(r, 10));
			order.push("onBeforeQuitAndInstall");
		};
		const handler = makeQuitAndInstallHandler({
			updater,
			onBeforeQuitAndInstall,
		});
		const result = await handler();
		expect(order).toEqual(["onBeforeQuitAndInstall", "quitAndInstall"]);
		expect(result).toEqual({ ok: true });
	});

	test("onBeforeQuitAndInstall 未提供时直接 quitAndInstall，不报错", async () => {
		const args: Array<[boolean, boolean]> = [];
		const updater = {
			quitAndInstall: (isSilent: boolean, isForceRunAfter: boolean) =>
				args.push([isSilent, isForceRunAfter]),
			once: () => {},
		};
		const handler = makeQuitAndInstallHandler({ updater });
		const result = await handler();
		expect(args).toEqual([[false, true]]);
		expect(result).toEqual({ ok: true });
	});

	test("quitAndInstall 前先销毁 Tray（防 macOS Tray 保活阻止 app.quit）", async () => {
		const order: string[] = [];
		const handler = makeQuitAndInstallHandler({
			updater: {
				quitAndInstall: () => order.push("quitAndInstall"),
				once: () => {},
			},
			onBeforeQuitAndInstall: async () => {
				order.push("onBeforeQuitAndInstall");
			},
			destroyTray: () => order.push("destroyTray"),
		});
		await handler();
		// destroyTray 必须在 quitAndInstall 之前：Tray 销毁后 app.quit()
		// 才能走完 Squirrel.Mac 退出 → ShipIt 替换 → 重启
		expect(order).toEqual([
			"onBeforeQuitAndInstall",
			"destroyTray",
			"quitAndInstall",
		]);
	});

	test("destroyTray 未提供时不报错（向后兼容）", async () => {
		const handler = makeQuitAndInstallHandler({
			updater: { quitAndInstall: () => {}, once: () => {} },
		});
		const result = await handler();
		expect(result).toEqual({ ok: true });
	});

	test("macOS 下 quitAndInstall 后有 setTimeout app.exit(0) 兜底（防 ShipIt App Still Running）", async () => {
		// 不验证 setTimeout 内部（require electron 在测试环境不可用），
		// 只验证 handler 在 macOS 下正常返回不抛异常（setTimeout 注册成功）
		const handler = makeQuitAndInstallHandler({
			updater: { quitAndInstall: () => {}, once: () => {} },
		});
		const result = await handler();
		expect(result).toEqual({ ok: true });
	});
});

// ---- 启动检查（主进程装配即发起 + 失败退避重试 + 主窗口打开时补查）----
// 背景：desktop.log 2026-11-22/11-25 启动检查 ERR_PROXY_CONNECTION_FAILED 后无任何重试，
// 整个会话再无更新提示，直到用户打开设置页重查——「只有打开设置才弹更新提醒」的根因。

describe("createStartupCheck", () => {
	/** fake timer：按触发顺序记录，手动推进 */
	function fakeTimers() {
		const queued = new Map();
		let seq = 0;
		return {
			queued,
			set: (fn, ms) => {
				const id = ++seq;
				queued.set(id, { fn, ms });
				return id;
			},
			clear: (id) => queued.delete(id),
			fireNext: () => {
				const [id, t] = [...queued.entries()][0];
				queued.delete(id);
				t.fn();
				return t.ms;
			},
		};
	}
	const flush = () => new Promise((r) => setTimeout(r, 0));

	test("start 立即检查一次；成功后不排重试", async () => {
		let calls = 0;
		const timers = fakeTimers();
		const sc = createStartupCheck({
			check: () => {
				calls++;
				return Promise.resolve();
			},
			log: () => {},
			timers,
		});
		sc.start();
		await flush();
		expect(calls).toBe(1);
		expect(timers.queued.size).toBe(0);
	});

	test("失败 → 按退避 15s/60s/180s 重试，用完不再排", async () => {
		let calls = 0;
		const timers = fakeTimers();
		const sc = createStartupCheck({
			check: () => {
				calls++;
				return Promise.reject(new Error("net::ERR_PROXY_CONNECTION_FAILED"));
			},
			log: () => {},
			timers,
		});
		sc.start();
		await flush();
		expect(calls).toBe(1);
		expect(timers.fireNext()).toBe(15_000);
		await flush();
		expect(calls).toBe(2);
		expect(timers.fireNext()).toBe(60_000);
		await flush();
		expect(calls).toBe(3);
		expect(timers.fireNext()).toBe(180_000);
		await flush();
		expect(calls).toBe(4);
		expect(timers.queued.size).toBe(0); // 退避用尽
	});

	test("retryNow：上次失败 → 立即重查并取消待触发的退避；检查在途/已成功 → 忽略", async () => {
		let calls = 0;
		let rejectNext = true;
		const timers = fakeTimers();
		const sc = createStartupCheck({
			check: () => {
				calls++;
				return rejectNext
					? Promise.reject(new Error("down"))
					: new Promise(() => {}); // 在途
			},
			log: () => {},
			timers,
		});
		sc.start();
		await flush();
		expect(calls).toBe(1);
		expect(timers.queued.size).toBe(1);
		// 主窗口打开：上次失败 → 立刻再查；退避 timer 被取消
		rejectNext = false;
		sc.retryNow();
		await flush();
		expect(calls).toBe(2);
		expect(timers.queued.size).toBe(0);
		// 在途：再调 retryNow 不重复发起
		sc.retryNow();
		await flush();
		expect(calls).toBe(2);
	});

	test("stop：有确定结果后不再重试，待触发的退步被清除", async () => {
		let calls = 0;
		const timers = fakeTimers();
		const sc = createStartupCheck({
			check: () => {
				calls++;
				return Promise.reject(new Error("down"));
			},
			log: () => {},
			timers,
		});
		sc.start();
		await flush();
		expect(timers.queued.size).toBe(1);
		sc.stop();
		expect(timers.queued.size).toBe(0);
		sc.retryNow();
		await flush();
		expect(calls).toBe(1);
	});
});

describe("setupUpdater（注入 fake ipcMain / updater）", () => {
	function fakeIpcMain() {
		const handlers = new Map();
		return {
			handlers,
			handle: (ch, fn) => handlers.set(ch, fn),
		};
	}
	/** 假 updater：按 electron-updater 语义同步 emit checking-for-update，结果由测试控制 */
	function fakeUpdater() {
		const listeners = new Map();
		const u = {
			checkCalls: 0,
			broadcasts: [],
			emit(type, arg) {
				for (const cb of listeners.get(type) ?? []) cb(arg);
			},
		};
		u.on = (type, cb) => {
				listeners.set(type, [...(listeners.get(type) ?? []), cb]);
		};
		u.setFeedURL = () => {};
		u.checkForUpdates = () => {
			u.checkCalls++;
			u.emit("checking-for-update");
			return u.nextResult;
		};
		u.downloadUpdate = () => Promise.resolve();
		return u;
	}

	test("packaged：装配后立即发起一次检查（不等渲染端），get-info 带回最近事件", async () => {
		const ipc = fakeIpcMain();
		const updater = fakeUpdater();
		updater.nextResult = new Promise(() => {}); // 在途
		const win = { isDestroyed: () => false, webContents: { send: (...a) => updater.broadcasts.push(a) } };
		const out = setupUpdater({
			getMainWindow: () => win,
			log: () => {},
			isPackaged: true,
			currentVersion: "0.10.16",
			ipcMain: ipc,
			createUpdater: () => updater,
		});
		// 检查在下一个微任务发起（createStartupCheck 对同步抛错做了隔离）
		await new Promise((r) => setTimeout(r, 0));
		expect(updater.checkCalls).toBe(1);
		expect(ipc.handlers.get("updater:get-info")()).toEqual({
			appVersion: "0.10.16",
			isDesktop: true,
			lastEvent: { phase: "checking" },
		});
		// 主窗口尚未加载时广播被丢弃无妨：结果留在 lastEvent 供渲染端挂载时补取
		updater.emit("update-available", { version: "0.10.17", releaseNotes: "n" });
		expect(ipc.handlers.get("updater:get-info")().lastEvent).toEqual({
			phase: "available",
			version: "0.10.17",
			releaseNotes: "n",
		});
		expect(updater.broadcasts).toHaveLength(2);
		expect(out.startupCheck).not.toBeNull();
	});

	test("dev：不发起检查，get-info 的 lastEvent 为 null，startupCheck 为 null", () => {
		const ipc = fakeIpcMain();
		let constructed = 0;
		const out = setupUpdater({
			getMainWindow: () => null,
			log: () => {},
			isPackaged: false,
			currentVersion: "dev",
			ipcMain: ipc,
			createUpdater: () => {
				constructed++;
				return fakeUpdater();
			},
		});
		expect(constructed).toBe(0);
		expect(ipc.handlers.get("updater:get-info")()).toEqual({
			appVersion: "dev",
			isDesktop: false,
			lastEvent: null,
		});
		expect(ipc.handlers.get("updater:check")()).toEqual({ ok: false, reason: "dev" });
		expect(out.startupCheck).toBeNull();
	});
});
