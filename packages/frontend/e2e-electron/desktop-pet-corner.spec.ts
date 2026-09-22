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

// 青蛙应能移动到屏幕的四个角（用户需求）。
// 原来横向留白 90px（溜达落点 / 拖动 / 缩放收敛 / 启动恢复四处都用了它），
// 所以永远到不了左右边缘，也就到不了四个角。期望：贴边可达。

const APP_CWD = join(import.meta.dirname, "..", "..", "desktop");
const USER_DATA_DIR = join(ELECTRON_E2E_DIR, "userdata-corner");

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

/** 走真实拖动路径把青蛙甩向左上角，返回落点与归属屏边界 */
async function dragToTopLeft(pet: Page) {
	return (await pet.evaluate(`
		(() => {
			st.wander = false; st.state = "idle";
			const home = screenAt(st.fx);
			// pointerdown 记 grab（与真实按下等价），再把宿主光标挪到极左极上
			gp = { x: st.fx, y: st.fy }; hostGp = { x: gp.x, y: gp.y };
			st.grab = [gp.x, gp.y, winX, winY]; st.moved = false;
			gp = { x: -999999, y: -999999 };
			winEl.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1 }));
			const out = {
				fx: Math.round(st.fx), fy: Math.round(st.fy),
				homeL: home.l, homeT: home.t, state: st.state,
			};
			st.grab = null;
			return JSON.stringify(out);
		})()
	`)) as string;
}

test.describe.serial("青蛙可移动到屏幕四角", () => {
	test("拖动能把青蛙放到左上角（贴左缘、贴上缘）", async () => {
		const pet = await findPetWindow();
		const r = JSON.parse(await dragToTopLeft(pet)) as {
			fx: number;
			fy: number;
			homeL: number;
			homeT: number;
			state: string;
		};
		// 确实进入了拖动状态
		expect(r.state).toBe("drag");
		// 横向：原来被 90px 挡住，现在应贴到左缘附近
		expect(r.fx - r.homeL).toBeLessThanOrEqual(20);
		// 纵向：头顶贴上缘（80K 以内），也贴到顶附近
		expect(r.fy - r.homeT).toBeLessThanOrEqual(120);
	});

	test("溜达落点也能落到屏幕左右边缘附近（不再恒在 90px 以内）", async () => {
		const pet = await findPetWindow();
		// 直接把青蛙摆到紧贴左缘处，验证它不会被「拉回」到 90px
		const out = (await pet.evaluate(`
			(() => {
				st.wander = false; st.state = "idle";
				const home = screenAt(st.fx);
				const target = home.l + 5;
				st.fx = target;
				applyScale(K);   // 走一遍缩放后的位置收敛（clamp 路径）
				const out = { fx: Math.round(st.fx), homeL: home.l };
				return JSON.stringify(out);
			})()
		`)) as string;
		const r = JSON.parse(out) as { fx: number; homeL: number };
		expect(r.fx - r.homeL).toBeLessThanOrEqual(20);
	});
});
