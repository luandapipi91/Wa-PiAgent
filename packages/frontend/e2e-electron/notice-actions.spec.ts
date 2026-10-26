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

// 通知卡片链路 Electron E2E（v2 自绘卡片窗口）：卡片显示与同会话合并、
// 点击卡片跳更新页（关于分区）、REST 建会话后点击卡片跳会话。
//
// 与真实链路一致（不再拦截 notice:send handler）：主窗口渲染进程直发
// preload 暴露的 waPiNotice.send（page.evaluate）→ 真实 IPC → 主进程
// notice:send handler → 队列合并 → 卡片窗口下行显示；点击卡片走真实上行
// notice-card:event → 主进程下发 notice:action → 主窗口跳转。全程无 mock。
// 发送不带 backgroundOnly（前台也显示卡片；渲染端真实请求由单测覆盖形状）。

const APP_CWD = join(import.meta.dirname, "..", "..", "desktop");
const USER_DATA_DIR = join(ELECTRON_E2E_DIR, "userdata-notice");
const KERNEL = `http://127.0.0.1:${ELECTRON_E2E_PORT}`;

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

/** 主窗口渲染进程直发通知（preload 桥 → notice:send 真实链路） */
async function sendNotice(payload: Record<string, unknown>): Promise<void> {
	await main.evaluate((p) => (window as any).waPiNotice.send(p), payload);
}

/** 卡片窗口页面（file://…/notice-card.html；send 后按需创建，轮询等待） */
async function cardWindow(): Promise<Page> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const card = app
			.windows()
			.find((w) => w.url().includes("notice-card.html"));
		if (card) return card;
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error("未在超时内找到卡片窗口");
}

/** 卡片窗口当前是否可见（node 侧 BrowserWindow.isVisible；hide 后 DOM 仍在，必须查窗口而非 DOM） */
async function cardVisible(): Promise<boolean> {
	return app.evaluate(({ BrowserWindow }) => {
		const card = BrowserWindow.getAllWindows().find(
			(w) =>
				!w.isDestroyed() &&
				(w.webContents.getURL() || "").includes("notice-card.html"),
		);
		return card ? card.isVisible() : false;
	});
}

/** 等卡片消失（5s 自动消失，或点击处理掉最后一条后立即隐藏） */
async function waitCardHidden(): Promise<void> {
	const deadline = Date.now() + 12_000;
	while (Date.now() < deadline) {
		if (!(await cardVisible())) return;
		await new Promise((r) => setTimeout(r, 300));
	}
	throw new Error("卡片窗口未在超时内消失");
}

test.beforeAll(async () => {
	rmSync(ELECTRON_E2E_DIR, { recursive: true, force: true });
	mkdirSync(USER_DATA_DIR, { recursive: true });
	app = await electron.launch({
		// user-data-dir 隔离 Electron 单例锁：用户正开着桌面端时也能跑
		args: [".", `--user-data-dir=${USER_DATA_DIR}`],
		cwd: APP_CWD,
		env: e2eEnv(),
	});

	// 主窗口（kernel 静态服务）；splash 是 data: URL，会被关闭，故按 http 前缀找
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		main = app.windows().find((w) => w.url().startsWith("http://127.0.0.1:"));
		if (main) break;
		await new Promise((r) => setTimeout(r, 300));
	}
	if (!main) throw new Error("未在超时内找到主窗口");
	// 等 React mount 完成：App useEffect 已注册 waPiNotice.onAction，
	// 此后卡片点击下发的 notice:action 才会被消费
	await main.waitForSelector('[data-testid="new-session-pane"]', {
		timeout: 120_000,
	});

	// 预置假 provider：无 provider 时前端自动弹首启向导遮住页面
	// （与 preview-window.spec.ts 同一套规避手法）
	await fetch(`${KERNEL}/api/providers`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			provider: {
				id: "e2e-notice-provider",
				name: "E2E Notice",
				baseUrl: "http://localhost:9999/v1",
				apiKey: "sk-e2e",
				api: "openai-completions",
				models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
			},
		}),
	});
	// 向导可能已在 provider 到达前弹出：直接关掉（providers 非空后不会再弹）
	const close = main.getByTestId("onboarding-wizard-close");
	if (await close.isVisible().catch(() => false)) {
		await close.click();
		await expect(main.getByTestId("onboarding-wizard")).toHaveCount(0);
	}
});

test.afterAll(async () => {
	await app?.close();
	rmSync(ELECTRON_E2E_DIR, { recursive: true, force: true });
});

test.describe.serial("通知卡片链路（v2 自绘卡片）", () => {
	test("两条不同会话各成条（2/2），同会话再发合并且条数不变、内容刷新", async () => {
		await waitCardHidden(); // 前置：无残留卡片
		const sid1 = "s-e2e-card-a-" + Math.random().toString(36).slice(2, 8);
		const sid2 = "s-e2e-card-b-" + Math.random().toString(36).slice(2, 8);

		// 第一条：卡片窗口出现，条数指示 1/1
		await sendNotice({
			title: "任务完成",
			body: "「会话甲」已完成",
			action: { type: "session", sessionId: sid1 },
			theme: "light",
		});
		let card = await cardWindow();
		await expect(card.locator("#count")).toHaveText("1/1");

		// 第二条（不同会话）：追加成条，index 指向新条（enqueue 契约，单测 notice.test.ts 同源），
		// 条数指示「当前/总数」→ 2/2（规格「交互规格」：条数指示只统计不同会话）
		await sendNotice({
			title: "任务完成",
			body: "「会话乙」已完成",
			action: { type: "session", sessionId: sid2 },
			theme: "light",
		});
		card = await cardWindow();
		await expect(card.locator("#count")).toHaveText("2/2");
		await expect(card.locator("#body")).toHaveText("「会话乙」已完成");

		// 同会话（sid2，当前显示条）再发：合并为一条（仍 2/2，条数不增）且内容刷新、
		// 位置不变（规格：新完成仅刷新该条内容，不改变队列位置）
		await sendNotice({
			title: "任务完成",
			body: "「会话乙」第二轮已完成",
			action: { type: "session", sessionId: sid2 },
			theme: "light",
		});
		await expect(card.locator("#count")).toHaveText("2/2");
		await expect(card.locator("#body")).toHaveText("「会话乙」第二轮已完成");

		// 收尾：等 5s 倒计时自动消失，队列清空，不影响下一条用例
		await waitCardHidden();
	});

	test("点击卡片跳更新页：设置弹窗打开并定位关于分区，卡片消失", async () => {
		await waitCardHidden(); // 前置：无残留卡片
		expect(main.getByTestId("settings-modal")).toHaveCount(0);

		// 发「新版本」条目（渲染端 initUpdateNotice 的 action 形状）
		await sendNotice({
			title: "发现新版本 v9.9.9",
			body: "点击查看新版本更新内容",
			action: { type: "update" },
			theme: "light",
		});
		const card = await cardWindow();
		await expect(card.locator("#title")).toHaveText("发现新版本 v9.9.9");

		// 真实点击卡片主体：上行 card:click → 主进程下发 notice:action({type:"update"})
		await card.locator("#card").click();

		// 设置弹窗打开且「关于」分区激活（about-section 仅在 about 分支渲染）
		await expect(main.getByTestId("settings-modal")).toBeVisible();
		await expect(main.getByTestId("settings-nav-about")).toBeVisible();
		await expect(main.getByTestId("about-section")).toBeVisible();
		// 点击 = 已处理最后一条：卡片消失
		await waitCardHidden();

		// 收尾关弹窗，不影响下一条用例
		await main.getByTestId("settings-close").click();
		await expect(main.getByTestId("settings-modal")).toHaveCount(0);
	});

	test("点击卡片跳会话：REST 建会话后发 session 条目，点击进对应会话", async () => {
		await waitCardHidden(); // 前置：无残留卡片

		// 经 kernel REST 准备真实会话（照原 spec 先例：prompt POST 返回时会话
		// 记录已落盘，模型调用的错误走 SSE 广播，不影响建会话；前端经 SSE 自动同步列表）
		const projectName = "e2e-notice-proj";
		const projectRes = await fetch(`${KERNEL}/api/projects`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: projectName, cwd: "/tmp/e2e-notice-proj" }),
		});
		expect(projectRes.ok).toBe(true);

		const sessionId =
			"s-e2e-notice-" + Math.random().toString(36).slice(2, 8);
		const promptRes = await fetch(
			`${KERNEL}/api/agents/${projectName}/${sessionId}/prompt`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					agentName: "dev",
					text: "e2e notice session",
					model: "model-a",
				}),
			},
		);
		expect(promptRes.ok).toBe(true);
		// 轮询项目列表确认会话已落盘（handleNoticeAction 的列表兜底重拉也以此为准）
		await expect
			.poll(
				async () => {
					const data = await (
						await fetch(`${KERNEL}/api/projects`)
					).json();
					return data.sessions?.some((s: any) => s.id === sessionId);
				},
				{ timeout: 10_000 },
			)
			.toBe(true);

		await sendNotice({
			title: "任务完成",
			body: "「e2e notice session」已完成",
			action: { type: "session", sessionId },
			theme: "light",
		});
		const card = await cardWindow();
		await expect(card.locator("#count")).toHaveText("1/1");

		// 真实点击卡片主体 → notice:action({type:"session",sessionId}) → 跳会话
		await card.locator("#card").click();

		// 会话视图出现（SessionView 渲染即跳转成功）
		await expect(main.getByTestId("session-view")).toBeVisible();
		await waitCardHidden();
	});
});
