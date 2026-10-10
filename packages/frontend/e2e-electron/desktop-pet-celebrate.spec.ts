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
//  · 对话完成不再做动作，只冒气泡随机说一句（10 句话术）
//  · 任何跳（无论溜达开关）都必须跳出去再跳回原位，不永久位移

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
		// 同步打开菜单并读出菜单项清单：E2E 的合成鼠标不移动系统光标，异步会撞上
		// 「光标离开菜单自动收起」导致菜单不可见。
		const probe = (await pet.evaluate(`
			(() => {
				showMainMenu(60, 60);
				const items = [...document.querySelectorAll("#menuInter .mi")].map((el) => ({
					act: el.dataset.act || null,
					text: el.textContent,
				}));
				const seps = document.querySelectorAll("#menuInter .sep").length;
				hideMenus();
				return { items, seps };
			})()
		`)) as { items: Array<{ act: string | null; text: string }>; seps: number };
		const menu = probe.items;

		const acts = menu.map((i) => i.act);
		// 分隔线只保留「缩放滑条↔动作」「动作↔溜达开关」两处：动作之间不再分组
		expect(probe.seps).toBe(2);
		// 不再区分「完成动作」与「互动动作」：菜单里保留全部动作项
		for (const a of [
			"hop", "croak", "hunt", "sing", "yawn", "look",
			"puff", "blep", "blow", "sneeze", "curious", "sleep", "wander",
		])
			expect(acts).toContain(a);
		// 「任务完成」仍是完成时的随机反应，不作为菜单文案出现
		expect(menu.some((i) => i.text.includes("任务完成"))).toBe(false);
	});

	test("对话完成：不做动作，只冒气泡随机说一句（溜达开/关都不变）", async () => {
		const pet = await findPetWindow();
		// 反复走「对话完成」的入口（溜达开/关各 30 次）：state 必须保持 idle（不做动作），
		// 只有气泡在说话，且 60 次里出现多种话术（随机）
		const probe = (await pet.evaluate(`
			(() => {
				const seen = new Set();
				for (const wander of [true, false]) {
					for (let i = 0; i < 30; i++) {
						st.state = "idle";
						st.fly = null;
						st.wander = wander;
						st.bubble_text = null;
						st.bubble_left = 0;
						startRandomCelebrate();
						if (st.state !== "idle") seen.add("动作:" + st.state);
						if (st.bubble_text) seen.add(st.bubble_text);
					}
				}
				return [...seen];
			})()
		`)) as string[];
		// 不做任何动作：state 全程保持 idle
		expect(probe.some((s) => s.startsWith("动作:"))).toBe(false);
		// 每次都说了话，且话术随机多样
		expect(probe.length).toBeGreaterThan(3);
	});

	test("溜达开启：hop 跳出去后也会跳回起跳点（快进两段跳跃动画）", async () => {
		const pet = await findPetWindow();
		const probe = (await pet.evaluate(`
			(() => {
				st.wander = true;   // 开着溜达也不许跳走：任何跳都必须回原位
				st.state = "idle"; st.fly = null; st.grab = null;
				st.next_hop_t = Infinity; st.next_special_t = Infinity;   // 禁自发调度：避免快进期间插入额外随机跳污染回位断言
				const origin = { x: st.fx, y: st.fy };
				runAction("hop");
				let maxDrift = 0;
				for (let i = 0; i < 400; i++) {   // 手动快进 tick（两段跳跃 ~100 tick 内完成）
					tick();
					maxDrift = Math.max(maxDrift, Math.hypot(st.fx - origin.x, st.fy - origin.y));
				}
				return { origin: { x: Math.round(origin.x), y: Math.round(origin.y) }, final: { x: Math.round(st.fx), y: Math.round(st.fy) }, maxDrift: Math.round(maxDrift), state: st.state };
			})()
		`)) as { origin: number; final: number; maxDrift: number; state: string };

		// 确实跳出去过（不然测的是寂寞）
		expect(probe.maxDrift).toBeGreaterThan(50);
		// 最终回到起跳点（x、y 都要回，±2px），不永久位移
		expect(Math.abs(probe.final.x - probe.origin.x)).toBeLessThanOrEqual(2);
		expect(Math.abs(probe.final.y - probe.origin.y)).toBeLessThanOrEqual(2);
	});

	test("溜达开启：curious 跳过去看完人，也会跳回来", async () => {
		const pet = await findPetWindow();
		const probe = (await pet.evaluate(`
			(() => {
				st.wander = true;   // 开着溜达也不许跳走：任何跳都必须回原位
				st.state = "idle"; st.fly = null; st.grab = null;
				st.next_hop_t = Infinity; st.next_special_t = Infinity;   // 禁自发调度：避免快进期间插入额外随机跳污染回位断言
				const origin = { x: st.fx, y: st.fy };
				runAction("curious");
				let maxDrift = 0;
				for (let i = 0; i < 500; i++) {   // 出游 + watchyou(100 tick) + 跳回
					tick();
					maxDrift = Math.max(maxDrift, Math.hypot(st.fx - origin.x, st.fy - origin.y));
				}
				return { origin: { x: Math.round(origin.x), y: Math.round(origin.y) }, final: { x: Math.round(st.fx), y: Math.round(st.fy) }, maxDrift: Math.round(maxDrift), state: st.state };
			})()
		`)) as { origin: number; final: number; maxDrift: number; state: string };

		expect(probe.maxDrift).toBeGreaterThan(30);
		expect(Math.abs(probe.final.x - probe.origin.x)).toBeLessThanOrEqual(2);
		expect(Math.abs(probe.final.y - probe.origin.y)).toBeLessThanOrEqual(2);
	});

	test("真实链路：主窗口转发庆祝 → 宠物冒气泡说话（不再做动作）", async () => {
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
