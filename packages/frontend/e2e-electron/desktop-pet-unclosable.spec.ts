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

// 宠物窗口不能被关闭（用户报告）：点一下宠物后按 cmd+w 就把宠物窗口关掉了，之后很难再打开。
// 根因：窗口没设 focusable:false，宠物可以被点成焦点窗口，而 macOS 菜单里的 close
// 作用于「当前焦点窗口」——于是 cmd+w 关掉的是宠物。
// 期望：宠物窗口不抢焦点；任何来自系统的关闭请求都被拦下；
//       只有应用内部通道（菜单「关闭桌面宠物」/ 设置开关）才真正销毁它。

const APP_CWD = join(import.meta.dirname, "..", "..", "desktop");
const USER_DATA_DIR = join(ELECTRON_E2E_DIR, "userdata-unclosable");

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

/** 宠物窗口的窗口级标志 */
async function petWindowFlags() {
	return app.evaluate(({ BrowserWindow, webContents }) => {
		const wc = webContents
			.getAllWebContents()
			.find((c) => c.getURL().includes("pet.html"));
		if (!wc) return null;
		const w = BrowserWindow.fromWebContents(wc);
		if (!w) return null;
		return {
			focusable: w.isFocusable(),
			closable: w.isClosable(),
			destroyed: w.isDestroyed(),
		};
	});
}

/** 直接请求关闭宠物窗口——等价于 cmd+w / 窗口菜单里的关闭 */
async function requestClosePet(): Promise<boolean> {
	return app.evaluate(({ BrowserWindow, webContents }) => {
		const wc = webContents
			.getAllWebContents()
			.find((c) => c.getURL().includes("pet.html"));
		const w = wc ? BrowserWindow.fromWebContents(wc) : null;
		if (!w) return false;
		w.close();
		return true;
	});
}

async function petWindowExists(): Promise<boolean> {
	return (await petWindowFlags()) !== null;
}

test.describe.serial("宠物窗口不可被关闭", () => {
	test("宠物窗口正常显示（拦截关闭不影响可见性）", async () => {
		const pet = await findPetWindow();
		// show() 发生在页面 did-finish-load 之后，所以要等
		await expect
			.poll(
				async () =>
					await app.evaluate(({ BrowserWindow, webContents }) => {
						const wc = webContents
							.getAllWebContents()
							.find((c) => c.getURL().includes("pet.html"));
						const w = wc ? BrowserWindow.fromWebContents(wc) : null;
						return w ? w.isVisible() && !w.isDestroyed() : false;
					}),
				{ timeout: 20_000 },
			)
			.toBe(true);
		// 页面仍可用
		expect(await pet.evaluate("1 + 1")).toBe(2);
	});

	test("来自系统的关闭请求被拦下：close() 之后窗口仍存活", async () => {
		await findPetWindow();
		expect(await requestClosePet()).toBe(true);
		await sleep(600);
		expect(await petWindowExists()).toBe(true);
		// 页面仍然可用（不是「假活」）
		const pet = await findPetWindow();
		expect(await pet.evaluate("1 + 1")).toBe(2);
	});
});
