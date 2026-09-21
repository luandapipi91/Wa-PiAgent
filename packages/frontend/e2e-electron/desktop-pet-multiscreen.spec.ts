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

// 多屏/光标坐标 bug 的复现与回归。
//
// 根因：附件页面用同一个 `gp` 变量装两种坐标系——
//   · 页面 mousemove 写入的是窗口局部坐标（pageX/pageY，0~260）
//   · 宿主 getCursorPos 轮询写入的是屏幕坐标（如 4471,1398）
// 浏览器预览模式下「窗口=虚拟屏」，两者恰好等价；Electron 下两者交替写入，
// 点击时 pointerdown 记下的 gp 与 pointermove 读到的 gp 不同源 → dx 变成数千像素
// → 判定为拖动 → 窗口被 clamp 到虚拟桌面边缘（肉眼就是「跑到另一块屏去了」）。

const APP_CWD = join(import.meta.dirname, "..", "..", "desktop");
const USER_DATA_DIR = join(ELECTRON_E2E_DIR, "userdata-multiscreen");

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

async function petBounds() {
	return app.evaluate(({ BrowserWindow, webContents }) => {
		const wc = webContents
			.getAllWebContents()
			.find((c) => c.getURL().includes("pet.html"));
		if (!wc) return null;
		const w = BrowserWindow.fromWebContents(wc);
		return w ? w.getBounds() : null;
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

test.describe.serial("多屏下的光标坐标与窗口位移", () => {
	test("Electron 下 gp 只来自宿主轮询（屏幕坐标），页面 mousemove 不得改写它", async () => {
		const pet = await findPetWindow();
		// 等宿主光标轮询至少跑一轮（40ms 一次）
		await new Promise((r) => setTimeout(r, 400));
		const probe = (await pet.evaluate(`
			(() => {
				const before = { x: gp.x, y: gp.y };
				// 真实路径：鼠标在窗口内移动 → 页面 mousemove（clientX/Y 是窗口局部坐标）
				winEl.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 7, clientY: 9 }));
				return { before, after: { x: gp.x, y: gp.y } };
			})()
		`)) as { before: { x: number; y: number }; after: { x: number; y: number } };

		// 宿主光标是屏幕坐标：宠物停在桌面某处，其坐标远大于窗口尺寸
		expect(probe.before.x).toBeGreaterThan(260);
		// 关键断言：mousemove 不能把 gp 改写成局部坐标 (7,9)
		expect(probe.after).toEqual(probe.before);
	});

	test("真实点一下宠物：窗口不被甩到另一块屏", async () => {
		const pet = await findPetWindow();
		// 关掉溜达，隔离变量：只留「点击」这一条影响窗口位置的路径
		await pet.evaluate(`(() => { st.wander = false; st.state = "idle"; })()`);
		await new Promise((r) => setTimeout(r, 300));
		const before = (await petBounds())!;

		// 真实鼠标序列：移到宠物上 → 按下 → 轻微抖动 → 抬起（等效用户点击）
		await pet.mouse.move(before.width / 2, before.height / 2);
		await pet.mouse.down();
		await pet.mouse.move(before.width / 2 + 3, before.height / 2 + 2, { steps: 2 });
		await pet.mouse.up();
		await new Promise((r) => setTimeout(r, 600));

		const after = (await petBounds())!;
		// 点击只触发「开心跳」（窗口内动画），窗口位置不该变
		expect(Math.abs(after.x - before.x)).toBeLessThan(30);
		expect(Math.abs(after.y - before.y)).toBeLessThan(30);
	});

	test("多屏：缩放时位置不被 clamp 到虚拟桌面左边缘", async () => {
		const pet = await findPetWindow();
		const out = (await pet.evaluate(`
			(() => {
				const saved = { virt: { ...virt }, fx: st.fx, fy: st.fy, k: K };
				// 模拟「副屏在主屏左侧」：虚拟桌面从 -1920 开始，宠物停在左侧屏内
				virt = { l: -1920, t: 0, r: 1920, b: 1080 };
				st.fx = -1500; st.fy = 900;
				applyScale(1.1);
				const result = { fx: st.fx, fy: st.fy };
				// 还原真实环境（缩放回原值并复位窗口）
				virt = saved.virt;
				st.fx = saved.fx; st.fy = saved.fy;
				applyScale(saved.k);
				return result;
			})()
		`)) as { fx: number; fy: number };

		// 仍留在左侧屏内（修复前会被 clamp 到 90，即跳到右侧屏）
		expect(out.fx).toBeLessThan(0);
		expect(out.fx).toBeGreaterThanOrEqual(-1920 + 90);
	});
});
