import {
	test,
	expect,
	_electron as electron,
	type ElectronApplication,
} from "@playwright/test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	ELECTRON_E2E_DIR,
	ELECTRON_E2E_PORT,
} from "../playwright.electron.config";

// 2026-11-28 回归：上次关闭时是最大化 → 本次启动在启动页阶段不得提前露出空白主窗口。
// 根因：createWindow 对 show:false 的隐藏窗口调 maximize()，而 Electron 的 maximize() 会直接把
// 窗口显示出来（Windows 首启实测：启动页还在、主窗口一片底色、标题还是应用名）。
// 修复：只记「待恢复」，到 revealMainWindow 显窗时再 maximize（代替 show，无尺寸跳变）。
// 夹具：启动前把 window_state.json（maximized:true）写进隔离 user-data-dir，走真实启动链路。

const APP_CWD = join(import.meta.dirname, "..", "..", "desktop");
const USER_DATA_DIR = join(ELECTRON_E2E_DIR, "userdata-winstatemax");

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

/** app.evaluate 在 launch 刚返回时可能报 "Resulting promise was garbage collected"（主进程尚未就绪）：短重试 */
async function evalWithRetry<T>(fn: (_electron: any) => T, timeoutMs = 30_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			return await app.evaluate(fn);
		} catch (e) {
			if (Date.now() > deadline) throw e;
			await new Promise((r) => setTimeout(r, 200));
		}
	}
}

/** 主窗口（排除启动页 data:、宠物 pet.html、通知卡片、预览/外链窗口）的真实窗口状态 */
async function mainWindowState(): Promise<{
	url: string;
	visible: boolean;
	maximized: boolean;
} | null> {
	return evalWithRetry(({ BrowserWindow }) => {
		const w = BrowserWindow.getAllWindows().find((x) => {
			if (x.isDestroyed()) return false;
			const u = x.webContents.getURL() || "";
			return (
				!u.startsWith("data:") &&
				!u.includes("pet.html") &&
				!u.includes("notice-card") &&
				!u.includes("link-window") &&
				!u.includes("preview")
			);
		});
		return w
			? { url: w.webContents.getURL(), visible: w.isVisible(), maximized: w.isMaximized() }
			: null;
	});
}

/** 启动页（data: URL 窗口）是否还在 */
async function splashAlive(): Promise<boolean> {
	return evalWithRetry(({ BrowserWindow }) =>
		BrowserWindow.getAllWindows().some(
			(x) => !x.isDestroyed() && (x.webContents.getURL() || "").startsWith("data:"),
		),
	);
}

test.beforeAll(async () => {
	rmSync(ELECTRON_E2E_DIR, { recursive: true, force: true });
	mkdirSync(USER_DATA_DIR, { recursive: true });
	// 上次关闭时是最大化：恢复路径必须走「显窗时 maximize」，不能在建窗时 maximize
	writeFileSync(
		join(USER_DATA_DIR, "window_state.json"),
		JSON.stringify({ x: 640, y: 266, width: 1280, height: 860, maximized: true }),
	);
	app = await electron.launch({
		args: [".", `--user-data-dir=${USER_DATA_DIR}`],
		cwd: APP_CWD,
		env: e2eEnv(),
	});
});

test.afterAll(async () => {
	await app?.close();
});

test.describe.serial("最大化状态恢复不得提前露出空白主窗口", () => {
	test("启动页阶段：主窗口已建但必须不可见（即使待恢复最大化）", async () => {
		// 先等启动页的 data: URL 提交（loadURL 刚发出时 getURL() 还是空串，不能拿来识别窗口）
		await expect
			.poll(() => splashAlive(), { timeout: 15_000 })
			.toBe(true);
		// 主窗口在 whenReady 同步创建，此时已存在；webContents 尚未加载真实页面
		const state = await mainWindowState();
		expect(state).not.toBeNull();
		// 观察时机必须早于页面加载完成，否则本用例无法证明「加载前不可见」
		if (state!.url.startsWith("http")) {
			throw new Error("未能在页面加载前观察到主窗口，用例时机失效，请重跑");
		}
		expect(state!.visible).toBe(false);
		expect(await splashAlive()).toBe(true);
	});

	test("显窗后：主窗口可见、处于最大化，启动页已关闭", async () => {
		await expect
			.poll(
				async () => {
					const s = await mainWindowState();
					return s && s.url.startsWith("http") && s.visible;
				},
				{ timeout: 120_000 },
			)
			.toBe(true);
		const state = await mainWindowState();
		expect(state!.maximized).toBe(true);
		await expect
			.poll(() => splashAlive(), { timeout: 10_000 })
			.toBe(false);
	});
});
