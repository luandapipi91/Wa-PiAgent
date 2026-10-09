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

// 拖动流畅性契约（用户报告：拖动青蛙过程中会抖动、不流畅）。
// 根因有三，各自一条用例锁定：
//  1. 拖动中 #win 偏移补偿未豁免：realWinX 是 40ms 前的滞后采样，
//     拖动中「期望位置−实际位置」是在飞位移而非系统顶回的静态偏差，
//     把它补到 left/top 会让窗口内容相对窗口来回甩（抖动主源）→ 拖动中必须冻结补偿。
//  2. setWinPos 无同值去重：pointermove 高频触发，同一位置重复发 pet:move IPC，
//     洪泛主进程反过来拖慢光标采样（越拖越卡）→ 同值请求不得重发。
//  3. 光标轮询固定 40ms（25Hz）：拖动跟随率上限=轮询率，高刷屏上肉眼可见跳格
//     → 拖动中提速到 16ms，松手恢复省电间隔。

const APP_CWD = join(import.meta.dirname, "..", "..", "desktop");
const USER_DATA_DIR = join(ELECTRON_E2E_DIR, "userdata-drag-smooth");

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

test.describe.serial("拖动流畅性", () => {
	test("拖动中 #win 偏移补偿冻结，松手后恢复重算", async () => {
		const pet = await findPetWindow();
		const probe = (await pet.evaluate(`
			(() => {
				st.state = "idle"; st.grab = null;
				// 制造「窗口在飞」的滞后采样：宿主实际位置比期望落后 60px
				const p0 = winPosFor(st.fx, st.fy);
				realWinX = p0.x - 60; realWinY = p0.y;
				applyPos();
				const idleOff = { x: WIN_OFF_X, y: WIN_OFF_Y };
				// 进入拖动态并拖出一段位移：期望窗口位置右移 100px，
				// realWinX−p.x 差值随之大变——若未冻结，补偿会被重算甩动
				st.state = "drag"; st.moved = true;
				st.grab = [gp.x, gp.y, winX, winY];
				st.fx += 100;
				WIN_OFF_X = 123; WIN_OFF_Y = 321;   // 人为设定「冻结基准」
				applyPos();
				const dragOff = { x: WIN_OFF_X, y: WIN_OFF_Y };
				// 松手：补偿恢复随采样重算（还原拖动位移，隔离「位置变化」与「状态切换」两个变量）
				st.state = "land"; st.grab = null;
				st.fx -= 100;
				applyPos();
				const afterOff = { x: WIN_OFF_X, y: WIN_OFF_Y };
				return { idleOff, dragOff, afterOff };
			})()
		`)) as { idleOff: { x: number; y: number }; dragOff: { x: number; y: number }; afterOff: { x: number; y: number } };

		// 拖动中：补偿冻结在人设基准，不被滞后采样重算
		expect(probe.dragOff).toEqual({ x: 123, y: 321 });
		// 拖动中的补偿值确实与非拖动态不同（说明「冻结」是有意义的差异，不是恒等巧合）
		expect(probe.idleOff).not.toEqual(probe.dragOff);
		// 松手后：恢复重算，回到与非拖动态一致的计算结果
		expect(probe.afterOff).toEqual(probe.idleOff);
	});

	test("setWinPos 去重：宿主已到位时同值不重发；漂移时同值也必须重发对齐", async () => {
		const pet = await findPetWindow();
		const probe = (await pet.evaluate(`
			(() => {
				const calls = [];
				const orig = sendMove;   // 移动请求的单一出口（function 声明可重绑，contextBridge 对象属性只读）
				sendMove = (x, y) => { calls.push([x, y]); };
				try {
					setWinPos(500, 400);           // 新位置 → 发
					const first = calls.length;
					realWinX = 500; realWinY = 400; // 模拟宿主已到位（轮询采样收敛）
					setWinPos(500, 400);           // 同值且宿主已到位 → 不发
					setWinPos(500.2, 400.4);       // 取整后同值且到位 → 不发
					const dedup = calls.length;
					realWinX = 4560; realWinY = 780; // 模拟窗口被外部擞走（主进程初始放置/系统顶回）→ 漂移
					setWinPos(500, 400);           // 同值但漂移 → 必须重发（否则校正永远发不出去）
					const realign = calls.length;
					setWinPos(520, 400);           // 新位置 → 发
					const second = calls.length;
					return { first, dedup, realign, second };
				} finally { sendMove = orig; }
			})()
		`)) as { first: number; dedup: number; realign: number; second: number };

		expect(probe.first).toBe(1);
		expect(probe.dedup).toBe(1);
		expect(probe.realign).toBe(2);
		expect(probe.second).toBe(3);
	});

	test("光标轮询间隔：拖动中提速到 16ms，非拖动态保持 40ms", async () => {
		const pet = await findPetWindow();
		const probe = (await pet.evaluate(`
			(() => {
				st.state = "idle";
				const idle = cursorPollMs();
				st.state = "drag";
				const drag = cursorPollMs();
				st.state = "land";
				const after = cursorPollMs();
				return { idle, drag, after };
			})()
		`)) as { idle: number; drag: number; after: number };

		expect(probe.idle).toBe(40);
		expect(probe.drag).toBe(16);
		expect(probe.after).toBe(40);
	});
});
