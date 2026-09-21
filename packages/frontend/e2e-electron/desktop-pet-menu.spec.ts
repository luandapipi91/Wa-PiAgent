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

// 右键菜单的可用性回归。
//
// 根因：宠物窗口只有 260×258，而 `.gmenu` 最小宽 150px、二级菜单固定展开在主菜单右侧
// （menuInter.style.left = menuRoot.right - 2）→ 二级菜单右边界远超窗口右边界被裁掉，
// 高度也被 maxHeight 压到几十像素。肉眼即「右键互动菜单出不来」。
// 修复方式：右键时把窗口临时放大到能容纳两级菜单，菜单关闭后恢复宠物窗口尺寸；
// 菜单展开期间不做点击穿透（否则点菜单外部关不掉菜单）。

const APP_CWD = join(import.meta.dirname, "..", "..", "desktop");
const USER_DATA_DIR = join(ELECTRON_E2E_DIR, "userdata-menu");

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

async function petContentSize() {
	return app.evaluate(({ BrowserWindow, webContents }) => {
		const wc = webContents
			.getAllWebContents()
			.find((c) => c.getURL().includes("pet.html"));
		if (!wc) return null;
		const w = BrowserWindow.fromWebContents(wc);
		return w ? w.getContentSize() : null;
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

test.describe.serial("宠物右键菜单", () => {
	test("右键青蛙：主菜单出现，且主菜单与二级「互动」菜单都完整落在窗口内", async () => {
		const pet = await findPetWindow();
		// 关掉溜达，避免测试期间窗口被溜达挪走
		await pet.evaluate(`(() => { st.wander = false; })()`);
		await new Promise((r) => setTimeout(r, 300));

		// 找青蛙本体上的点（不硬编码坐标：青蛙位置受缩放/呼吸/位移影响）
		const pt = (await pet.evaluate(`
			(() => {
				const isShape = (el) => el && el.namespaceURI === "http://www.w3.org/2000/svg" && el.tagName.toLowerCase() !== "svg";
				for (let y = 8; y < innerHeight; y += 4)
					for (let x = 8; x < innerWidth; x += 4) {
						const el = document.elementFromPoint(x, y);
						if (isShape(el)) return { x, y, tag: el.tagName };
					}
				return null;
			})()
		`)) as { x: number; y: number; tag: string } | null;
		expect(pt).toBeTruthy();

		await pet.mouse.click(pt!.x, pt!.y, { button: "right" });

		const menu = await pet.evaluate(`
			(() => {
				const r = menuRoot.getBoundingClientRect();
				return {
					display: getComputedStyle(menuRoot).display,
					rect: { l: r.left, t: r.top, r: r.right, b: r.bottom },
					win: { w: innerWidth, h: innerHeight },
				};
			})()
		`);
		expect(menu.display).not.toBe("none");
		expect(menu.rect.r).toBeLessThanOrEqual(menu.win.w);
		expect(menu.rect.b).toBeLessThanOrEqual(menu.win.h);

		// 悬停「互动」→ 二级菜单展开，必须完整落在窗口内（修复前右边界远超窗口宽）
		await pet.locator("#miInter").hover();
		await new Promise((r) => setTimeout(r, 200));
		const sub = await pet.evaluate(`
			(() => {
				const r = menuInter.getBoundingClientRect();
				return {
					display: getComputedStyle(menuInter).display,
					rect: { l: r.left, t: r.top, r: r.right, b: r.bottom, h: r.height },
					win: { w: innerWidth, h: innerHeight },
				};
			})()
		`);
		expect(sub.display).toBe("block");
		expect(sub.rect.r).toBeLessThanOrEqual(sub.win.w);
		expect(sub.rect.b).toBeLessThanOrEqual(sub.win.h);
		// 二级菜单要有实际可读高度（不是被 maxHeight 压成几十像素）
		expect(sub.rect.h).toBeGreaterThan(120);
	});

	test("菜单展开时窗口放大，关闭后恢复宠物窗口尺寸", async () => {
		const pet = await findPetWindow();
		const openSize = await petContentSize();
		expect(openSize![0]).toBeGreaterThan(260);

		// 点菜单外部关闭（菜单展开期间不穿透，点击能到达页面）
		await pet.mouse.click(openSize![0] - 8, openSize![1] - 8);
		await new Promise((r) => setTimeout(r, 500));
		const closed = await pet.evaluate(
			`(() => ({ display: getComputedStyle(menuRoot).display }))()`,
		);
		expect(closed.display).toBe("none");
		const restored = await petContentSize();
		expect(restored![0]).toBe(260);
		expect(restored![1]).toBe(258);
	});

	test("拖动大小滑条时菜单在屏幕上保持原位（不跟着窗口跑）", async () => {
		const pet = await findPetWindow();
		await pet.evaluate(`(() => { st.wander = false; })()`);
		await new Promise((r) => setTimeout(r, 300));

		const pt = (await pet.evaluate(`
			(() => {
				const isShape = (el) => el && el.namespaceURI === "http://www.w3.org/2000/svg" && el.tagName.toLowerCase() !== "svg";
				for (let y = 8; y < innerHeight; y += 4)
					for (let x = 8; x < innerWidth; x += 4)
						if (isShape(document.elementFromPoint(x, y))) return { x, y };
				return null;
			})()
		`)) as { x: number; y: number } | null;
		expect(pt).toBeTruthy();
		await pet.mouse.click(pt!.x, pt!.y, { button: "right" });
		await new Promise((r) => setTimeout(r, 400));

		// 菜单在**屏幕**上的位置 = 窗口位置 + 菜单相对窗口的位置
		const menuScreenPos = `(() => {
			const r = menuRoot.getBoundingClientRect();
			return { x: winX + r.left, y: winY + r.top };
		})()`;
		const before = (await pet.evaluate(menuScreenPos)) as { x: number; y: number };

		// 等效拖动滑条：滑条 input 就是连续调 applyScale
		await pet.evaluate(`(() => { applyScale(1.6); })()`);
		await new Promise((r) => setTimeout(r, 600));
		const mid = (await pet.evaluate(menuScreenPos)) as { x: number; y: number };
		expect(Math.abs(mid.x - before.x)).toBeLessThan(12);
		expect(Math.abs(mid.y - before.y)).toBeLessThan(12);

		await pet.evaluate(`(() => { applyScale(0.8); })()`);
		await new Promise((r) => setTimeout(r, 600));
		const after = (await pet.evaluate(menuScreenPos)) as { x: number; y: number };
		expect(Math.abs(after.x - before.x)).toBeLessThan(12);
		expect(Math.abs(after.y - before.y)).toBeLessThan(12);

		// 收尾：还原缩放并关菜单（不影响后续用例）
		await pet.evaluate(`(() => { applyScale(1); hideMenus(); })()`);
	});
});
