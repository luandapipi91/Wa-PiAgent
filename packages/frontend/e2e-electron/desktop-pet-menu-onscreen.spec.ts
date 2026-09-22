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

// 菜单越界（用户报告）：
//   1) 菜单在窗口边缘会超出屏幕 —— 菜单定位只按「窗口内坐标」算，没考虑屏幕边界；
//      窗口恒为 560×660 且中心对齐青蛙，宠物在屏幕右下角时窗口右下部分在屏幕外，
//      菜单落在那一侧就看不见。
//   2) 二级「互动」菜单总出现在左侧 —— 展开方向按窗口宽度(560)判断，
//      主菜单在青蛙位置(窗口中部 x≈280)时右侧只剩约 280px，放不下就一律翻左。
// 期望：菜单始终完整落在屏幕内；右侧屏幕空间放得下就向右展开。

const APP_CWD = join(import.meta.dirname, "..", "..", "desktop");
const USER_DATA_DIR = join(ELECTRON_E2E_DIR, "userdata-menu-onscreen");

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

type Box = { l: number; r: number; t: number; b: number };
type Rects = {
	virt: Box;
	winX: number;
	winY: number;
	menu: Box;
	sub: Box;
};

/** 同步打开主菜单 + 二级菜单并测量（视口坐标），随后收起 */
async function openMenusAndMeasure(pet: Page, mx: number, my: number): Promise<Rects> {
	return (await pet.evaluate(`
		(() => {
			st.wander = false;
			showMainMenu(${mx}, ${my});
			menuInter.style.display = "block";
			layoutSubMenu(${my});
			const box = (el) => {
				const r = el.getBoundingClientRect();
				return { l: r.left, r: r.right, t: r.top, b: r.bottom };
			};
			const out = { virt: { ...virt }, winX, winY, menu: box(menuRoot), sub: box(menuInter) };
			hideMenus();
			return out;
		})()
	`)) as Rects;
}

/** 视口坐标 → 屏幕坐标（窗口左上角 + 视口坐标） */
function toScreen(box: Box, rects: Rects): Box {
	return {
		l: box.l + rects.winX,
		r: box.r + rects.winX,
		t: box.t + rects.winY,
		b: box.b + rects.winY,
	};
}

test.describe.serial("右键菜单不超出屏幕", () => {
	test("青蛙贴着屏幕右下角：主菜单与二级菜单都完整落在屏幕内", async () => {
		const pet = await findPetWindow();
		// 把窗口挪到屏幕右下角（窗口右下大半在屏幕外）
		await pet.evaluate(`(() => { setWinPos(virt.r - 140, virt.b - 160); })()`);
		await sleep(600);

		const rects = await openMenusAndMeasure(pet, 120, 260);
		for (const box of [rects.menu, rects.sub]) {
			const s = toScreen(box, rects);
			expect(s.l).toBeGreaterThanOrEqual(rects.virt.l - 1);
			expect(s.t).toBeGreaterThanOrEqual(rects.virt.t - 1);
			expect(s.r).toBeLessThanOrEqual(rects.virt.r + 1);
			expect(s.b).toBeLessThanOrEqual(rects.virt.b + 1);
		}
	});

	test("二级菜单按屏幕空间决定方向：右侧放得下就在右边，贴了屏幕右缘才翻到左边", async () => {
		const pet = await findPetWindow();

		// 窗口位置每帧由锚点校正，所以用锚点构造（不能用 setWinPos）
		// 情形 1：窗口在屏幕内偏左 → 主菜单右侧屏幕空间充足 → 二级在右
		await pet.evaluate(`(() => { st.fx = virt.l + 320; st.fy = virt.t + 450; })()`);
		await sleep(600);
		const right = await openMenusAndMeasure(pet, 20, 300);
		expect(right.winX).toBeLessThan(right.virt.r - 600);
		expect(right.sub.l).toBeGreaterThanOrEqual(right.menu.r - 4);

		// 情形 2：窗口右缘贴屏幕右缘 → 主菜单右缘已到屏幕边 → 二级翻到左
		await pet.evaluate(`(() => { st.fx = virt.r - 280; st.fy = virt.t + 450; })()`);
		await sleep(600);
		const left = await openMenusAndMeasure(pet, 400, 300);
		expect(left.winX + 560).toBeGreaterThan(left.virt.r - 4);
		expect(left.sub.r).toBeLessThanOrEqual(left.menu.l + 4);
	});

	test("窗口被系统顶回时（青蛙在屏顶），菜单的屏幕换算仍用实际窗口位置", async () => {
		const pet = await findPetWindow();
		// 把锚点设到纵向上限：窗口会被系统顶回（期望 top 为负、实际停在菜单栏下方）
		await pet.evaluate(`(() => { st.wander = false; st.state = "idle"; st.fy = frogFyRange().min; })()`);
		await sleep(900);
		const r = JSON.parse(
			(await pet.evaluate(`
				(() => {
					const home = screenAt(st.fx);
					const sr = screenRectInWindow();
					const bx = realWinX === null ? winX : realWinX;
					const by = realWinY === null ? winY : realWinY;
					// 菜单在窗口内定位，因此屏幕矩形必须由「实际」窗口位置换算；
					// 用页面自算的期望位置（winX/winY）会在窗口被顶回时整体偏移。
					return JSON.stringify({
						srT: Math.round(sr.t), 期望T: Math.round(home.t - by),
						srR: Math.round(sr.r), 期望R: Math.round(home.r - bx),
						页面winY: Math.round(winY), 实际realWinY: realWinY === null ? null : Math.round(realWinY),
					});
				})()
			`)) as string,
		) as { srT: number; 期望T: number; srR: number; 期望R: number; 页面winY: number; 实际realWinY: number | null };
		// 窗口确实被顶回了（期望与实际差很大），否则这条用例就失去意义
		expect(Math.abs(r.页面winY - (r.实际realWinY ?? r.页面winY))).toBeGreaterThan(50);
		expect(Math.abs(r.srT - r.期望T)).toBeLessThanOrEqual(2);
		expect(Math.abs(r.srR - r.期望R)).toBeLessThanOrEqual(2);
	});

	test("多屏：菜单不越出宠物所在的那块屏（在第一块屏右侧右键，不会跑到第二块屏）", async () => {
		const pet = await findPetWindow();
		const res = (await pet.evaluate(`
			(() => {
				// 造两块屏：左屏 0..1440、右屏 1440..2880（不依赖真实多屏环境）
				// startHop 等会 refreshScreens()，同步块内先把它停掉
				refreshScreens = () => {};
				const A = { l: 0, t: 0, r: 1440, b: 900 };
				const B = { l: 1440, t: 0, r: 2880, b: 900 };
				screens = [A, B];
				virt = { l: 0, t: 0, r: 2880, b: 900 };
				st.wander = false;
				// 宠物停在左屏靠右处
				st.fx = 1300; st.fy = 450;
				const p = winPosFor(st.fx, st.fy);
				setWinPos(p.x, p.y);
				// 在窗口内靠右的位置右键（修复前会把菜单 clamp 到 virt.r，即右屏右缘）
				showMainMenu(420, 300);
				menuInter.style.display = "block";
				layoutSubMenu(300);
				const box = (el) => {
					const r = el.getBoundingClientRect();
					return { l: r.left, t: r.top, r: r.right, b: r.bottom };
				};
				const out = { home: A, winX, winY, menu: box(menuRoot), sub: box(menuInter) };
				hideMenus();
				return out;
			})()
		`)) as { home: Box; winX: number; winY: number; menu: Box; sub: Box };

		for (const b of [res.menu, res.sub]) {
			const s = { l: b.l + res.winX, r: b.r + res.winX, t: b.t + res.winY, b: b.b + res.winY };
			expect(s.l).toBeGreaterThanOrEqual(res.home.l - 1);
			expect(s.r).toBeLessThanOrEqual(res.home.r + 1); // 关键：不越到第二块屏
			expect(s.t).toBeGreaterThanOrEqual(res.home.t - 1);
			expect(s.b).toBeLessThanOrEqual(res.home.b + 1);
		}
	});
});
