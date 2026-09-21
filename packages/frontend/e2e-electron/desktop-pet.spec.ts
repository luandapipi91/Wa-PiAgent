import {
	test,
	expect,
	_electron as electron,
	type ElectronApplication,
	type Page,
} from "@playwright/test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	ELECTRON_E2E_DIR,
	ELECTRON_E2E_PORT,
} from "../playwright.electron.config";

// 桌面宠物是真实系统窗口（透明/无边框/不置顶），只有跑起真 Electron 才能验：
// 窗口属性、开关建窗/销窗、庆祝落地、位置记忆、穿透链路、右键关闭回执。

const APP_CWD = join(import.meta.dirname, "..", "..", "desktop");
const USER_DATA_DIR = join(ELECTRON_E2E_DIR, "userdata");
const CONFIG_FILE = join(USER_DATA_DIR, "guagua_config.json");
const PET_MARK = "pet.html";

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
	timeoutMs = 30_000,
): Promise<Page> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		for (const w of app.windows()) if (predicate(w.url())) return w;
		await new Promise((r) => setTimeout(r, 300));
	}
	throw new Error("未在超时内找到目标窗口");
}

const findPetWindow = () => findWindow((u) => u.includes(PET_MARK));

/** 主进程视角的宠物窗口状态（不存在则 null，用它判断建窗/销窗） */
async function petState() {
	return app.evaluate(({ BrowserWindow, webContents }) => {
		const wc = webContents
			.getAllWebContents()
			.find((c) => c.getURL().includes("pet.html"));
		if (!wc) return null;
		const w = BrowserWindow.fromWebContents(wc);
		if (!w) return null;
		return {
			visible: w.isVisible(),
			alwaysOnTop: w.isAlwaysOnTop(),
			bounds: w.getBounds(),
			content: w.getContentBounds(),
		};
	});
}

async function openSettingsAppearance(page: Page) {
	await page.keyboard.press("Escape"); // 冷启动可能弹引导/模型未配置 modal
	await page.getByTestId("settings-btn").click();
	await expect(page.getByTestId("settings-modal")).toBeVisible();
	await page.getByTestId("settings-nav-appearance").click();
}

test.beforeAll(async () => {
	// 隔离目录从零开始：上轮残留的 guagua_config.json（位置记忆）会干扰断言
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

test.describe.serial("桌面宠物由透明独立窗口承载", () => {
	test("默认开启：宠物窗口存在、260×258、无边框、非置顶、背景透明", async () => {
		const pet = await findPetWindow();
		await expect
			.poll(async () => (await petState())?.visible, { timeout: 20_000 })
			.toBe(true);
		const state = (await petState())!;
		expect(state.bounds.width).toBe(260);
		expect(state.bounds.height).toBe(258);
		// 无边框：内容区高度 == 窗口高度
		expect(state.content.height).toBe(state.bounds.height);
		// 置顶：切换到其它应用后仍浮在其窗口之上（需求变更，原为普通窗口层级）
		expect(state.alwaysOnTop).toBe(true);
		// 页面在透明宿主模式下确实去掉了不透明背景
		expect(
			await pet.evaluate(() =>
				document.body.classList.contains("transparent-host"),
			),
		).toBe(true);
	});

	test("设置 → 外观：关闭开关销毁窗口，重新打开再建窗", async () => {
		await openSettingsAppearance(main);
		const toggle = main.getByTestId("desktop-pet-toggle");
		await expect(toggle).toHaveAttribute("data-on", "true");

		await toggle.click();
		await expect(toggle).toHaveAttribute("data-on", "false");
		await expect
			.poll(async () => Boolean(await petState()), { timeout: 15_000 })
			.toBe(false);

		await toggle.click();
		await expect(toggle).toHaveAttribute("data-on", "true");
		const pet = await findPetWindow();
		await expect
			.poll(async () => (await petState())?.visible, { timeout: 20_000 })
			.toBe(true);
		expect(
			await pet.evaluate(() =>
				document.body.classList.contains("transparent-host"),
			),
		).toBe(true);
		await main.getByTestId("settings-close").click();
	});

	test("对话完成：主窗口转发 → 宠物随机做一个动作（不再固定为庆祝）", async () => {
		const pet = await findPetWindow();
		await pet.evaluate(`(() => { st.state = "idle"; st.bubble_text = null; })()`);
		await main.evaluate(() => window.waPiPet?.celebrate());
		// 动作是随机的（庆祝只是池中之一）：只断言「确实动了」，不断言具体哪一个
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

	test("位置记忆：挪动 + 保存 → 销毁重建后回到同一位置", async () => {
		const pet = await findPetWindow();
		// 用页面自己的 setWinPos 挪窗口（页面内部 winX/winY 同步更新，行为与拖动一致）。
		// 注意用字符串形式 evaluate：virt/st/AX 等是页面脚本的顶层词法变量，TS 回调里无法直接引用。
		const target = (await pet.evaluate(`
			(() => {
				const x = Math.max(virt.l + 120, 120);
				const y = Math.max(virt.t + 120, 160);
				st.fx = x + AX; st.fy = y + AY;
				setWinPos(x, y);
				finishDrag();// 拖动收尾 → 保存位置
				return { x, y, fx: Math.round(st.fx), fy: Math.round(st.fy) };
			})()
		`)) as { x: number; y: number; fx: number; fy: number };
		await expect
			.poll(
				() => {
					try {
						return JSON.parse(readFileSync(CONFIG_FILE, "utf8")).pos;
					} catch {
						return null;
					}
				},
				{ timeout: 15_000 },
			)
			.toEqual({ x: target.fx, y: target.fy });

		// 关闭再打开：页面 boot 读到 pos 后落位
		await openSettingsAppearance(main);
		const toggle = main.getByTestId("desktop-pet-toggle");
		await toggle.click();
		await expect
			.poll(async () => Boolean(await petState()), { timeout: 15_000 })
			.toBe(false);
		await toggle.click();
		await findPetWindow();
		await expect
			.poll(async () => (await petState())?.bounds.x, { timeout: 20_000 })
			.toBe(target.x);
		expect((await petState())!.bounds.y).toBe(target.y);
		await main.getByTestId("settings-close").click();
	});

	test("点击穿透：光标在透明区 → 通知主进程忽略鼠标；移到青蛙上 → 收回", async () => {
		const pet = await findPetWindow();
		// 主进程侧记录 setIgnoreMouseEvents 调用（真实链路：页面 → IPC → Electron API）
		await app.evaluate(({ BrowserWindow, webContents }) => {
			const wc = webContents
				.getAllWebContents()
				.find((c) => c.getURL().includes("pet.html"))!;
			const w = BrowserWindow.fromWebContents(wc)!;
			(globalThis as any).__ctCalls = [];
			const orig = w.setIgnoreMouseEvents.bind(w);
			(w as any).setIgnoreMouseEvents = (flag: boolean, opts?: any) => {
				(globalThis as any).__ctCalls.push({ flag, opts });
				orig(flag, opts);
			};
		});

		// 扫描窗口内两类点：命中 SVG 图形的（青蛙本体）与命中空白区的。
		// 不硬编码坐标：青蛙窗口内坐标受缩放/位移/呼吸动画影响，每帧都在变。
		const probe = (await pet.evaluate(`
			(() => {
				const isShape = (el) => el && el.namespaceURI === "http://www.w3.org/2000/svg" && el.tagName.toLowerCase() !== "svg";
				let shapePt = null, blankPt = null;
				for (let y = 4; y < innerHeight && !(shapePt && blankPt); y += 6) {
					for (let x = 4; x < innerWidth; x += 6) {
						const el = document.elementFromPoint(x, y);
						if (isShape(el)) { if (!shapePt) shapePt = { x, y, tag: el.tagName }; }
						else if (!blankPt) blankPt = { x, y, tag: el ? el.tagName : null };
						if (shapePt && blankPt) break;
					}
				}
				return { shapePt, blankPt };
			})()
		`)) as {
			shapePt: { x: number; y: number; tag: string } | null;
			blankPt: { x: number; y: number; tag: string | null } | null;
		};
		expect(probe.shapePt).toBeTruthy();
		expect(probe.blankPt).toBeTruthy();

		// 光标落在透明区（#win 之外的窗口角落）→ 穿透开启
		const throughFlag = await pet.evaluate(`
			(() => { hostGp = { x: winX + ${probe.blankPt!.x}, y: winY + ${probe.blankPt!.y} }; clickThrough = false; checkClickThrough(); return clickThrough; })()
		`);
		expect(throughFlag).toBe(true);

		// 光标移到青蛙本体（命中 SVG 图形）→ 收回穿透
		const onFrog = await pet.evaluate(`
			(() => { hostGp = { x: winX + ${probe.shapePt!.x}, y: winY + ${probe.shapePt!.y} }; checkClickThrough(); return clickThrough; })()
		`);
		expect(onFrog).toBe(false);

		const flags = await app.evaluate(
			() => (globalThis as any).__ctCalls as any[],
		);
		expect(flags.map((f) => f.flag)).toEqual([true, false]);
		expect(flags[0].opts).toEqual({ forward: true });

		// 收尾：光标归还给宿主轮询（清掉测试注入值）
		await pet.evaluate(`(() => { hostGp = null; })()`);
	});

	test("右键菜单「关闭」：窗口销毁且设置开关自动置关", async () => {
		const pet = await findPetWindow();
		await pet.mouse.click(130, 100, { button: "right" });
		await pet.locator("#miClose").click();
		await expect
			.poll(async () => Boolean(await petState()), { timeout: 15_000 })
			.toBe(false);

		await openSettingsAppearance(main);
		await expect(main.getByTestId("desktop-pet-toggle")).toHaveAttribute(
			"data-on",
			"false",
		);
		await main.getByTestId("settings-close").click();
	});
});
