import { test, expect, describe } from "bun:test";
import {
	translateUpdaterEvent,
	updaterPhases,
	makeQuitAndInstallHandler,
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

	test("macOS 下注册 update-downloaded 事件回调（ShipIt 就绪后 app.exit 绕过 relaunch）", async () => {
		const registered: string[] = [];
		const handler = makeQuitAndInstallHandler({
			updater: {
				quitAndInstall: () => {},
				once: (event: string) => registered.push(event),
			},
		});
		await handler();
		// macOS 下必须注册 update-downloaded 监听：ShipIt 准备就绪信号，
		// 触发时 app.exit(0) 绕过 Squirrel.Mac 的 relaunch（否则 ShipIt "App Still Running"）
		if (process.platform === "darwin") {
			expect(registered).toContain("update-downloaded");
		}
	});
});
