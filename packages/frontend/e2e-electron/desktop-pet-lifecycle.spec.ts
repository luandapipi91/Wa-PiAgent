import {
	test,
	expect,
	_electron as electron,
	type ElectronApplication,
	type Page,
} from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	ELECTRON_E2E_DIR,
	ELECTRON_E2E_PORT,
} from "../playwright.electron.config";

// 宠物窗口生命周期：销毁路径不得让主进程抛未捕获异常。
//
// 现象（用户跑 E2E 时看到）：
//   Uncaught Exception: TypeError: Object has been destroyed
//     at BrowserWindow.visibilityChanged (node:electron/js2c/browser_init:...)
// 根因：pet-window.cjs 用 win.destroy() 强制销毁**可见**的窗口，跳过了正常关闭流程，
// 系统的可见性变化事件在对象已释放后才被 Electron 内部钩子处理 → 抛错。
// 仓库既有的预览窗口一律 hide() / close()，从不用 destroy()。

const APP_CWD = join(import.meta.dirname, "..", "..", "desktop");
const USER_DATA_DIR = join(ELECTRON_E2E_DIR, "userdata-lifecycle");

function e2eEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !key.startsWith("WA_PI_")) env[key] = value;
	}
	return {
		...env,
		WA_PI_DIR: ELECTRON_E2E_DIR,
		WA_PI_WS_PORT: String(ELECTRON_E2E_PORT),
		WA_PI_SKIP_AGENT_SEED: "1",
		WA_PI_CHANNELS_MOCK: "1",
	};
}

let app: ElectronApplication;
let main: Page;
/** 主进程 stdout/stderr 全量（异常就在这里面） */
const procLines: string[] = [];

const abnormal = () =>
	procLines.filter((l) =>
		/Object has been destroyed|Uncaught Exception|visibilityChanged/i.test(l),
	);

async function findWindow(
	predicate: (url: string) => boolean,
	timeoutMs = 60_000,
): Promise<Page> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		for (const w of app.windows()) if (predicate(w.url())) return w;
		await new Promise((r) => setTimeout(r, 300));
	}
	throw new Error("未在超时内找到目标窗口");
}

const findPetWindow = () => findWindow((u) => u.includes("pet.html"));

async function petExists(): Promise<boolean> {
	return app.evaluate(({ BrowserWindow, webContents }) => {
		const wc = webContents
			.getAllWebContents()
			.find((c) => c.getURL().includes("pet.html"));
		return Boolean(wc && BrowserWindow.fromWebContents(wc));
	});
}

test.beforeAll(async () => {
	rmSync(ELECTRON_E2E_DIR, { recursive: true, force: true });
	mkdirSync(USER_DATA_DIR, { recursive: true });
	app = await electron.launch({
		args: [".", `--user-data-dir=${USER_DATA_DIR}`],
		cwd: APP_CWD,
		env: e2eEnv(),
	});
	app.process().stdout?.on("data", (d) => procLines.push(String(d)));
	app.process().stderr?.on("data", (d) => procLines.push(String(d)));
	main = await findWindow((u) => u.startsWith("http://127.0.0.1:"), 120_000);
	await main.waitForSelector('[data-testid="new-session-pane"]', {
		timeout: 120_000,
	});
});

test.afterAll(async () => {
	try {
		await app?.close();
	} catch {
		/* 退出场景下可能已被关闭 */
	}
});

test.describe.serial("宠物窗口销毁路径", () => {
	test("反复「建窗 → 用户点关闭」不产生主进程未捕获异常", async () => {
		for (let i = 0; i < 3; i++) {
			// 走前端真实路径建窗（设置开关 → waPiPet.setEnabled → 主进程 create）
			await main.evaluate(() => window.waPiPet?.setEnabled(true));
			const pet = await findPetWindow();
			// 等窗口真正显示出来（异常只在「销毁可见窗口」时出现）
			await expect
				.poll(async () => pet.evaluate(() => document.visibilityState), {
					timeout: 20_000,
				})
				.toBe("visible");
			await new Promise((r) => setTimeout(r, 500));

			// 用户点宠物右键菜单里的「关闭桌面宠物」→ host.close() → 主进程销毁窗口
			await pet.evaluate(`(() => { host.close(); })()`);
			await expect
				.poll(async () => petExists(), { timeout: 15_000 })
				.toBe(false);
			await new Promise((r) => setTimeout(r, 600));
		}
		expect(abnormal()).toEqual([]);
	});

	test("主进程对「已销毁窗口的系统事件竞态」有窄兜底：注入该错误不会带走应用", async () => {
		const listeners = await app.evaluate(() =>
			process.listenerCount("uncaughtException"),
		);
		// 先断言兜底存在：不存在时直接失败返回，不往下注入——否在会弹出 Electron 的原生
		// 错误框（"A JavaScript error occurred in the main process"）干扰桌面（已经发生过一次）。
		expect(listeners).toBeGreaterThan(0);

		// 注入 Electron 那类错误（与观察到的 visibilityChanged 堆栈同类）
		await app.evaluate(() => {
			process.emit(
				"uncaughtException",
				new TypeError("Object has been destroyed"),
			);
		});
		await new Promise((r) => setTimeout(r, 500));

		// 应用仍存活：主进程还能响应、窗口都还在
		const windows = await app.evaluate(({ BrowserWindow }) =>
			BrowserWindow.getAllWindows().length,
		);
		expect(windows).toBeGreaterThan(0);
		expect(abnormal()).toEqual([]);
	});

	test("应用退出（销毁存量可见窗口）不产生主进程未捕获异常", async () => {
		// 先确保有一个正在显示的宠物窗口
		await main.evaluate(() => window.waPiPet?.setEnabled(true));
		const pet = await findPetWindow();
		await expect
			.poll(async () => pet.evaluate(() => document.visibilityState), {
				timeout: 20_000,
			})
			.toBe("visible");
		await new Promise((r) => setTimeout(r, 500));

		await app.close();
		await new Promise((r) => setTimeout(r, 1500));
		expect(abnormal()).toEqual([]);
	});
});
