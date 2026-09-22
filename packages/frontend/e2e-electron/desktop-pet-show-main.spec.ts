import {
	test,
	expect,
	_electron as electron,
	type ElectronApplication,
	type Page,
} from "@playwright/test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ELECTRON_E2E_DIR, ELECTRON_E2E_PORT } from "../playwright.electron.config";

// 主窗口收起后，点击宠物把它重新打开（用户需求）。
// 背景：主窗口点关闭是 hide 到托盘，且顺带 app.dock.hide()——连 Dock 图标都消失，
// 那时没有别的入口可以唤回主窗口；宠物窗口是唯一还看得见的东西。
// 期望：点击宠物（不是拖动）→ 主窗口重新显示；主窗口本来就开着时不打扰。

const APP_CWD = join(import.meta.dirname, "..", "..", "desktop");
const USER_DATA_DIR = join(ELECTRON_E2E_DIR, "userdata-show-main");

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

async function findPetWindow(timeoutMs = 60_000): Promise<Page> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		for (const w of app.windows()) if (w.url().includes("pet.html")) return w;
		await new Promise((r) => setTimeout(r, 300));
	}
	throw new Error("未在超时内找到宠物窗口");
}

test.beforeAll(async () => {
	rmSync(ELECTRON_E2E_DIR, { recursive: true, force: true });
	mkdirSync(USER_DATA_DIR, { recursive: true });
	app = await electron.launch({
		args: [".", `--user-data-dir=${USER_DATA_DIR}`],
		cwd: APP_CWD,
		env: e2eEnv(),
	});
});

test.afterAll(async () => {
	await app?.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 主窗口是否可见（主窗口是加载 http 地址的那个；宠物窗口是 file:// pet.html） */
async function mainWinVisible(): Promise<boolean | null> {
	return app.evaluate(({ BrowserWindow }) => {
		const w = BrowserWindow.getAllWindows().find(
			(x) => !x.isDestroyed() && (x.webContents.getURL() || "").startsWith("http"),
		);
		return w ? w.isVisible() : null;
	});
}

/** 收起主窗口（与点关闭按钮同一条路径） */
async function hideMain(): Promise<boolean> {
	return app.evaluate(({ BrowserWindow }) => {
		const w = BrowserWindow.getAllWindows().find(
			(x) => !x.isDestroyed() && (x.webContents.getURL() || "").startsWith("http"),
		);
		if (!w) return false;
		w.hide();
		return true;
	});
}

test.describe.serial("点击宠物唤回主窗口", () => {
	test("主窗口收起后：点击宠物把它重新打开", async () => {
		const pet = await findPetWindow();
		expect(await hideMain()).toBe(true);
		await expect.poll(() => mainWinVisible(), { timeout: 10_000 }).toBe(false);

		// 真实鼠标点击宠物体（窗口 560×660，#win 居中，中心即宠物本体）
		await pet.mouse.click(280, 330);
		await expect.poll(() => mainWinVisible(), { timeout: 10_000 }).toBe(true);
	});

	test("主窗口本来开着：点击宠物只是逗它，不会出问题", async () => {
		const pet = await findPetWindow();
		expect(await mainWinVisible()).toBe(true);
		await pet.mouse.click(280, 330);
		await sleep(400);
		expect(await mainWinVisible()).toBe(true);
	});
});
