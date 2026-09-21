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

// 缩放与菜单尺寸的联动。
//
// 现象（用户报告）：宠物放大到 200% 后，右键菜单「缩小了」。
// 根因链：
//   1) 页面 applyScale() 只改 DOM 几何（#win 变成 520×516），**不调 host.setWindowSize**，
//      窗口内容尺寸仍是 260×258 —— 与嵌入说明「页面会自行调 setWindowSize」不符。
//   2) 菜单打开时窗口放大到 560×520、主菜单 top 只 clamp 到「主菜单自己放得下」，
//      于是鼠标在放大后的窗口里点得越靠下，二级菜单的 maxHeight（H - top - 30）越小，
//      实测能被压到 ~90px —— 看起来就是「菜单缩小了」。

const APP_CWD = join(import.meta.dirname, "..", "..", "desktop");
const USER_DATA_DIR = join(ELECTRON_E2E_DIR, "userdata-scale-menu");

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

async function petContentSize(): Promise<[number, number] | null> {
	return app.evaluate(({ BrowserWindow, webContents }) => {
		const wc = webContents
			.getAllWebContents()
			.find((c) => c.getURL().includes("pet.html"));
		if (!wc) return null;
		const w = BrowserWindow.fromWebContents(wc);
		return w ? (w.getContentSize() as [number, number]) : null;
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
});

test.afterAll(async () => {
	await app?.close();
});

test.describe.serial("缩放与右键菜单尺寸", () => {
	test("滑条放大到 200%：窗口内容尺寸同步为 520×516，缩回 100% 回到 260×258", async () => {
		const pet = await findPetWindow();
		await pet.evaluate(`(() => { applyScale(2); })()`);
		await expect
			.poll(async () => (await petContentSize())?.[0], { timeout: 15_000 })
			.toBe(520);
		expect((await petContentSize())![1]).toBe(516);

		await pet.evaluate(`(() => { applyScale(1); })()`);
		await expect
			.poll(async () => (await petContentSize())?.[0], { timeout: 15_000 })
			.toBe(260);
		expect((await petContentSize())![1]).toBe(258);
	});

	test("200% 缩放下在宠物下部右键：二级菜单仍完整可用（不被压成一条）", async () => {
		const pet = await findPetWindow();
		await pet.evaluate(`(() => { st.wander = false; applyScale(2); })()`);
		// 等窗口尺寸同步生效
		await expect
			.poll(async () => (await petContentSize())?.[0], { timeout: 15_000 })
			.toBe(520);
		await new Promise((r) => setTimeout(r, 500));

		// 找青蛙本体上最靠下的可命中点：模拟用户在放大后的宠物下半身右键
		const pt = (await pet.evaluate(`
			(() => {
				const isShape = (el) => el && el.namespaceURI === "http://www.w3.org/2000/svg" && el.tagName.toLowerCase() !== "svg";
				let last = null;
				for (let y = 8; y < innerHeight; y += 4)
					for (let x = 8; x < innerWidth; x += 4) {
						const el = document.elementFromPoint(x, y);
						if (isShape(el)) { last = { x, y }; }
					}
				return last;
			})()
		`)) as { x: number; y: number } | null;
		expect(pt).toBeTruthy();

		await pet.mouse.click(pt!.x, pt!.y, { button: "right" });
		await new Promise((r) => setTimeout(r, 400));
		await pet.locator("#miInter").hover();
		await new Promise((r) => setTimeout(r, 300));

		const layout = await pet.evaluate(`
			(() => {
				const m = menuRoot.getBoundingClientRect();
				const s = menuInter.getBoundingClientRect();
				return {
					win: { w: innerWidth, h: innerHeight },
					menu: { t: m.top, b: m.bottom },
					sub: { t: s.top, r: s.right, b: s.bottom, h: s.height },
				};
			})()
		`);
		// 二级菜单要有可用高度（修复前在下方右键时只剩 ~90px）
		expect(layout.sub.h).toBeGreaterThan(400);
		expect(layout.sub.r).toBeLessThanOrEqual(layout.win.w);
		expect(layout.sub.b).toBeLessThanOrEqual(layout.win.h);

		// 收尾：还原缩放，避免影响后续用例
		await pet.evaluate(`(() => { applyScale(1); hideMenus(); })()`);
	});
});
