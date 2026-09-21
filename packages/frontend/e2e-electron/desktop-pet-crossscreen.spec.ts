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

// 多屏不跨屏（用户报告）：青蛙会因为自发动作（溜达/蹦跶）跳到别的屏幕去。
// 根因：startHop() 里 20% 概率「随机挑一块屏」直接跳过去；其余情况的目标点只按
// 整个虚拟桌面 virt 的边界 clamp，宠物贴着屏幕边缘起跳就会落到相邻屏。
// 期望：自发动作始终留在宠物当前所在的屏幕内；只有用户拖动才允许换屏（换屏后归属屏随之改变）。

const APP_CWD = join(import.meta.dirname, "..", "..", "desktop");
const USER_DATA_DIR = join(ELECTRON_E2E_DIR, "userdata-crossscreen");

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

test.describe.serial("自发动作不跨屏", () => {
	test("贴着屏幕右缘起跳也不会落到邻屏；拖动换屏后动作留在新屏内", async () => {
		const pet = await findPetWindow();
		const res = (await pet.evaluate(`
			(() => {
				// 造两块虚拟屏（不依赖真实多屏环境）；
				// startHop() 开头会 refreshScreens() 从宿主重新读，所以先把它停掉
				refreshScreens = () => {};
				const A = { l: 0, t: 0, r: 1440, b: 900 };
				const B = { l: 1440, t: 0, r: 2880, b: 900 };
				screens = [A, B];
				virt = { l: 0, t: 0, r: 2880, b: 900 };
				const bad = [];
				// 贴 A 屏右缘（距边界仅 100px，而一次跳跃最远 460px）：目标必须仍在 A 内
				st.fx = 1340; st.fy = 450;
				for (let i = 0; i < 80; i++) {
					startHop();
					if (st.x1 < A.l + 90 || st.x1 > A.r - 90) bad.push([i, Math.round(st.x1)]);
				}
				// 用户把它拖到 B 屏后，归属屏变成 B：后续动作都留在 B 内
				st.fx = 2100; st.fy = 450;
				let inB = 0;
				for (let i = 0; i < 80; i++) {
					startHop();
					if (st.x1 < B.l + 90 || st.x1 > B.r - 90) bad.push(["B", i, Math.round(st.x1)]);
					else inB++;
				}
				return { bad, inB };
			})()
		`)) as { bad: unknown[]; inB: number };

		expect(res.bad).toEqual([]);
		expect(res.inB).toBe(80);
	});
});
