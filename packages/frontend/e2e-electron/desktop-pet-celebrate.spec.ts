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

// 对话完成后的宠物动作：
//  · 互动菜单里不再提供「任务完成」手动入口（用户要求移除）
//  · 对话完成时一定动，但动作从多个里随机挑（庆祝只是其中之一）

const APP_CWD = join(import.meta.dirname, "..", "..", "desktop");
const USER_DATA_DIR = join(ELECTRON_E2E_DIR, "userdata-celebrate");

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

test.beforeAll(async () => {
	rmSync(ELECTRON_E2E_DIR, { recursive: true, force: true });
	mkdirSync(USER_DATA_DIR, { recursive: true });
	app = await electron.launch({
		args: [".", `--user-data-dir=${USER_DATA_DIR}`],
		cwd: APP_CWD,
		env: e2eEnv(),
	});
	main = await findWindow((u) => u.startsWith("http://127.0.0.1:"), 120_000);
	await main.waitForSelector('[data-testid="new-session-pane"]', {
		timeout: 120_000,
	});
});

test.afterAll(async () => {
	await app?.close();
});

test.describe.serial("对话完成后的宠物动作", () => {
	test("互动菜单里不再有「任务完成」项", async () => {
		const pet = await findPetWindow();
		await pet.evaluate(`(() => { st.wander = false; })()`);
		await new Promise((r) => setTimeout(r, 400));

		// 在青蛙本体上右键打开菜单（不硬编码坐标）
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
		await pet.locator("#miInter").hover();
		await new Promise((r) => setTimeout(r, 300));

		// 菜单里不得再有「任务完成」这一项（也不得出现在任何菜单文案里）
		await expect(
			pet.locator('#menuInter .mi[data-act="celebrate"]'),
		).toHaveCount(0);
		await expect(pet.locator("#menuInter")).not.toContainText("任务完成");
		// 其它动作项仍在（只移除了这一项）
		await expect(pet.locator('#menuInter .mi[data-act="hop"]')).toHaveCount(1);
		await pet.evaluate(`(() => { hideMenus(); })()`);
	});

	test("对话完成：一定动，且动作在多个之间随机（不是固定庆祝）", async () => {
		const pet = await findPetWindow();
		// 反复走「对话完成」的入口，收集实际进入的状态
		const seen = (await pet.evaluate(`
			(() => {
				const out = {};
				for (let i = 0; i < 60; i++) {
					st.state = "idle";
					startRandomCelebrate();
					out[st.state] = (out[st.state] || 0) + 1;
				}
				return out;
			})()
		`)) as Record<string, number>;

		const actions = Object.keys(seen);
		// 一定动：每次调用都进了某个动作态（不只停在 idle）
		const movedCount = Object.entries(seen)
			.filter(([k]) => k !== "idle")
			.reduce((s, [, v]) => s + v, 0);
		expect(movedCount).toBe(60);
		// 动作随机：60 次里出现多种动作
		expect(actions.filter((a) => a !== "idle").length).toBeGreaterThan(1);
	});

	test("真实链路：主窗口转发庆祝 → 宠物确实做了动作（气泡或动作态）", async () => {
		const pet = await findPetWindow();
		await pet.evaluate(`(() => { st.state = "idle"; st.bubble_text = null; })()`);
		await main.evaluate(() => window.waPiPet?.celebrate());
		await expect
			.poll(
				async () =>
					pet.evaluate(
						`(() => st.state !== "idle" || (st.bubble_text ?? "") !== "")()`,
					),
				{ timeout: 15_000 },
			)
			.toBe(true);
	});
});
