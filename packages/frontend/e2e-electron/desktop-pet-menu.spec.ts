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
		// 同步打开菜单并展开二级菜单：E2E 的合成鼠标不会移动系统光标，异步流程会撞上
		// 「光标离开菜单区自动收起」（真实用户右键时光标就在菜单上，不会遇到）。
		const layout = (await pet.evaluate(`
			(() => {
				showMainMenu(60, 60);
				menuInter.style.display = "block";
				layoutSubMenu(parseFloat(menuRoot.style.top) || 60);
				const m = menuRoot.getBoundingClientRect();
				const s = menuInter.getBoundingClientRect();
				const W = Math.max(innerWidth, MENU_WIN_W);
				const H = Math.max(innerHeight, MENU_WIN_H);
				const out = {
					win: { w: W, h: H },
					menu: { l: m.left, t: m.top, r: m.right, b: m.bottom },
					sub: { l: s.left, r: s.right, b: s.bottom, h: s.height },
				};
				hideMenus();
				return out;
			})()
		`)) as {
			win: { w: number; h: number };
			menu: { l: number; t: number; r: number; b: number };
			sub: { l: number; r: number; b: number; h: number };
		};

		expect(layout.menu.r).toBeLessThanOrEqual(layout.win.w);
		expect(layout.menu.b).toBeLessThanOrEqual(layout.win.h);
		// 二级菜单必须完整落在窗口内（修复前右边界远超窗口宽，被裁掉）
		expect(layout.sub.r).toBeLessThanOrEqual(layout.win.w);
		expect(layout.sub.b).toBeLessThanOrEqual(layout.win.h);
		// 二级菜单要有实际可读高度（不是被 maxHeight 压成几十像素）
		expect(layout.sub.h).toBeGreaterThan(120);
	});

	test("菜单展开时窗口放大，关闭后恢复宠物窗口尺寸", async () => {
		const pet = await findPetWindow();
		// 自包含：先同步展开菜单（窗口应放大到能容纳两级菜单）
		await pet.evaluate(`(() => { showMainMenu(60, 60); })()`);
		await expect
			.poll(async () => (await petContentSize())?.[0], { timeout: 15_000 })
			.toBe(560);

		// 再同步收起：窗口恢复宠物尺寸
		await pet.evaluate(`(() => { hideMenus(); })()`);
		await expect
			.poll(async () => (await petContentSize())?.[0], { timeout: 15_000 })
			.toBe(260);
		expect((await petContentSize())![1]).toBe(258);
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

		// 菜单在**屏幕**上的位置 = 窗口位置 + 菜单相对窗口的位置。
		// 同步执行（不跨帧）：E2E 的合成鼠标不会移动系统光标，异步等待会触发
		// 「光标离开菜单区自动收起」，那属于测试环境错位、不是真实用户场景。
		const shifted = (await pet.evaluate(`
			(() => {
				const pos = () => { const r = menuRoot.getBoundingClientRect(); return { x: winX + r.left, y: winY + r.top }; };
				const before = pos();
				const out = [];
				for (const k of [1.6, 0.8, 1.0]) { applyScale(k); out.push(pos()); }
				return { before, out };
			})()
		`)) as {
			before: { x: number; y: number };
			out: Array<{ x: number; y: number }>;
		};
		for (const p of shifted.out) {
			expect(Math.abs(p.x - shifted.before.x)).toBeLessThan(12);
			expect(Math.abs(p.y - shifted.before.y)).toBeLessThan(12);
		}

		// 收尾：关菜单（不影响后续用例）
		await pet.evaluate(`(() => { hideMenus(); })()`);
	});

	test("点菜单外部：那里保持穿透（点击直接落到桌面）+ 菜单随后自动收起", async () => {
		const pet = await findPetWindow();
		await pet.evaluate(`(() => { st.wander = false; })()`);
		await new Promise((r) => setTimeout(r, 300));

		// 全程同步执行：E2E 的合成鼠标不移动系统光标，异步等待会撞上「光标离开菜单
		// 自动收起」（真实用户右键时光标就在菜单上，不会遇到）。
		const probe = (await pet.evaluate(`
			(() => {
				showMainMenu(innerWidth / 2, 60);   // 等效右键打开（同步）
				const out = { openBefore: getComputedStyle(menuRoot).display };
				// 1) 菜单外（窗口左下角透明区）→ 穿透：点它会直接落到桌面
				hostGp = { x: winX + 12, y: winY + innerHeight - 12 };
				clickThrough = false;
				checkClickThrough();
				out.outsidePierces = clickThrough;
				// 2) 菜单内 → 不穿透（否则点不到菜单项）
				const r = menuRoot.getBoundingClientRect();
				hostGp = { x: winX + r.left + r.width / 2, y: winY + r.top + r.height / 2 };
				clickThrough = true;
				checkClickThrough();
				out.insideHolds = clickThrough;
				// 3) 光标离开菜单区持续约 1.2 秒（30 帧）→ 菜单自动收起
				for (let i = 0; i < 40; i++) {
					hostGp = { x: winX + 12, y: winY + innerHeight - 12 };
					checkMenuDismiss();
				}
				out.closed = getComputedStyle(menuRoot).display;
				return out;
			})()
		`)) as {
			openBefore: string;
			outsidePierces: boolean;
			insideHolds: boolean;
			closed: string;
		};

		expect(probe.openBefore).toBe("block");
		expect(probe.outsidePierces).toBe(true);
		expect(probe.insideHolds).toBe(false);
		expect(probe.closed).toBe("none");
	});

	test("拖大小滑条时菜单不被截断（主菜单与二级菜单都完整落在窗口内）", async () => {
		const pet = await findPetWindow();
		const probe = (await pet.evaluate(`
			(() => {
				st.wander = false;
				showMainMenu(60, 60);
				menuInter.style.display = "block";
				layoutSubMenu(60);
				const out = [];
				for (const k of [1.2, 1.5, 1.8, 2.0, 1.0]) {
					applyScale(k);
					const m = menuRoot.getBoundingClientRect();
					const s = menuInter.getBoundingClientRect();
					out.push({
						k,
						W: Math.max(innerWidth, MENU_WIN_W),
						H: Math.max(innerHeight, MENU_WIN_H),
						menu: { l: m.left, r: m.right, t: m.top, b: m.bottom },
						sub: { l: s.left, r: s.right, t: s.top, b: s.bottom },
					});
				}
				hideMenus();
				applyScale(1);
				return out;
			})()
		`)) as Array<{
			k: number;
			W: number;
			H: number;
			menu: { l: number; r: number; t: number; b: number };
			sub: { l: number; r: number; t: number; b: number };
		}>;

		for (const s of probe) {
			expect(s.menu.l).toBeGreaterThanOrEqual(0);
			expect(s.menu.t).toBeGreaterThanOrEqual(0);
			expect(s.menu.r).toBeLessThanOrEqual(s.W);
			expect(s.menu.b).toBeLessThanOrEqual(s.H);
			expect(s.sub.l).toBeGreaterThanOrEqual(0);
			expect(s.sub.t).toBeGreaterThanOrEqual(0);
			expect(s.sub.r).toBeLessThanOrEqual(s.W);
			expect(s.sub.b).toBeLessThanOrEqual(s.H);
		}
	});
});
