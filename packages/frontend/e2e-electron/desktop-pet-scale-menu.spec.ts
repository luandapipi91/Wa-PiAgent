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
	test("宠物窗口尺寸恒定（560×660）：缩放只改窗口内部，不再改窗口几何", async () => {
		const pet = await findPetWindow();
		// 初始就是固定尺寸
		expect(await petContentSize()).toEqual([560, 660]);
		for (const k of [2, 0.5, 1]) {
			await pet.evaluate(`(() => { applyScale(${k}); })()`);
			await new Promise((r) => setTimeout(r, 300));
			expect(await petContentSize()).toEqual([560, 660]);
		}
	});

	test("200% 缩放下在宠物下部右键：二级菜单仍完整可用（不被压成一条）", async () => {
		const pet = await findPetWindow();
		// 同步执行：E2E 的合成鼠标不移动系统光标，异步会撞上「光标离开菜单自动收起」，
		// 且窗口尺寸是 IPC 异步生效的；这里直接同步走菜单布局代码。
		const layout = (await pet.evaluate(`
			(() => {
				st.wander = false;
				applyScale(2);
				// 模拟在放大后宠物的下半身右键（y=500 在固定尺寸窗口里已很深）
				placeMenu(60, 500);
				menuInter.style.display = "block";
				layoutSubMenu(500);
				const m = menuRoot.getBoundingClientRect();
				const s = menuInter.getBoundingClientRect();
				const W = Math.max(innerWidth, WIN_MAX_W);
				const H = Math.max(innerHeight, WIN_MAX_H);
				return {
					win: { w: W, h: H },
					menu: { t: m.top, b: m.bottom },
					sub: { t: s.top, r: s.right, b: s.bottom, h: s.height },
				};
			})()
		`)) as {
			win: { w: number; h: number };
			menu: { t: number; b: number };
			sub: { t: number; r: number; b: number; h: number };
		};

		// 二级菜单要有可用高度（修复前在下方右键时只剩 ~90px）
		expect(layout.sub.h).toBeGreaterThan(400);
		expect(layout.sub.r).toBeLessThanOrEqual(layout.win.w);
		expect(layout.sub.b).toBeLessThanOrEqual(layout.win.h);

		// 收尾：关菜单并还原缩放
		await pet.evaluate(`(() => { hideMenus(); applyScale(1); })()`);
	});

	test("缩放时青蛙视觉中心在屏幕上不动（按中心对齐而非脚底对齐）", async () => {
		const pet = await findPetWindow();
		const probe = (await pet.evaluate(`
			(() => {
				st.wander = false;
				const center = () => ({ x: winX + WIN_MAX_W / 2, y: winY + WIN_MAX_H / 2 });
				const first = center();
				const steps = [];
				for (const k of [1.3, 1.7, 2.0, 0.8, 1.0]) {
					applyScale(k);
					const c = center();
					steps.push({ k, dx: c.x - first.x, dy: c.y - first.y });
				}
				return { first, steps };
			})()
		`)) as {
			first: { x: number; y: number };
			steps: Array<{ k: number; dx: number; dy: number }>;
		};

		for (const s of probe.steps) {
			expect(Math.abs(s.dx)).toBeLessThan(3);
			expect(Math.abs(s.dy)).toBeLessThan(3);
		}
	});

	test("菜单展开/收起期间窗口位置与锚点都不变（只改尺寸）", async () => {
		const pet = await findPetWindow();
		const probe = (await pet.evaluate(`
			(() => {
				const snap = () => ({ x: winX, y: winY, fx: st.fx, fy: st.fy });
				const before = snap();
				showMainMenu(60, 60);
				const opened = snap();
				hideMenus();
				const closed = snap();
				return { before, opened, closed };
			})()
		`)) as {
			before: { x: number; y: number; fx: number; fy: number };
			opened: { x: number; y: number; fx: number; fy: number };
			closed: { x: number; y: number; fx: number; fy: number };
		};

		expect(probe.opened).toEqual(probe.before);
		expect(probe.closed).toEqual(probe.before);
	});

	test("缩放过程中菜单在屏幕上完全不动（窗口几何恒定）", async () => {
		const pet = await findPetWindow();
		const probe = (await pet.evaluate(`
			(() => {
				st.wander = false;
				showMainMenu(60, 60);
				menuInter.style.display = "block";
				layoutSubMenu(60);
				const snap = () => {
					const m = menuRoot.getBoundingClientRect();
					const s = menuInter.getBoundingClientRect();
					return {
						winX, winY,
						menu: { l: m.left, r: m.right, t: m.top, b: m.bottom },
						sub: { l: s.left, r: s.right, t: s.top, b: s.bottom },
					};
				};
				const first = snap();
				const steps = [];
				for (const k of [1.3, 1.7, 2.0, 0.7, 1.0]) {
					menuAwayTicks = 0;   // 保持菜单展开
					applyScale(k);
					steps.push(snap());
				}
				hideMenus();
				return { first, steps };
			})()
		`)) as {
			first: {
				winX: number;
				winY: number;
				menu: { l: number; r: number; t: number; b: number };
				sub: { l: number; r: number; t: number; b: number };
			};
			steps: Array<{
				winX: number;
				winY: number;
				menu: { l: number; r: number; t: number; b: number };
				sub: { l: number; r: number; t: number; b: number };
			}>;
		};

		for (const s of probe.steps) {
			// 窗口位置不变
			expect(s.winX).toBe(probe.first.winX);
			expect(s.winY).toBe(probe.first.winY);
			// 主菜单与二级菜单的窗口内位置都不变
			expect(Math.abs(s.menu.l - probe.first.menu.l)).toBeLessThan(2);
			expect(Math.abs(s.menu.t - probe.first.menu.t)).toBeLessThan(2);
			expect(Math.abs(s.sub.l - probe.first.sub.l)).toBeLessThan(2);
			expect(Math.abs(s.sub.t - probe.first.sub.t)).toBeLessThan(2);
		}
	});
});
