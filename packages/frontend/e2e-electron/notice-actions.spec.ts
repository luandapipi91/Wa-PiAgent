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

// 通知链路 Electron E2E：场景②「更新可用 → 系统通知」+ 场景①②「点击通知跳转」。
//
// 两个与真实链路的偏差（探针实证后的方案，均为 Electron 机制使然，非本分支实现缺口）：
// 1. 打点方式：contextBridge 暴露的 waPiNotice 属性不可变（页面覆盖赋值静默失败），
//    渲染端包一层 send 记录不可行 → 改在主进程 ipcMain.removeHandler("notice:send")
//    后注册记录版 handler：同一 IPC 入口记录完整载荷；顺带不弹真实系统通知
//    （避免 E2E 机器触发 macOS 首次授权弹窗），真实发送逻辑由真机手工验收覆盖。
// 2. 更新可用触发：dev（未打包）主进程 updater:check 被 dev 占位短路（updater.cjs
//    `if (!isPackaged)` 直接 return，防误触发真实更新），WA_PI_UPDATER_FEED_URL
//    指向的 mock feed 在 dev 下不生效 → 改为广播 updater:event {phase:"available"}
//    （与 electron-updater 事件经 translateUpdaterEvent 广播的载荷同构），覆盖
//    渲染端 store 状态机 → initUpdateNotice 订阅 → notice:send 的真实链路；
//    electron-updater 拉取 feed 的段由 desktop 单测与真机手工验收（简报步骤 4）覆盖。

const APP_CWD = join(import.meta.dirname, "..", "..", "desktop");
const USER_DATA_DIR = join(ELECTRON_E2E_DIR, "userdata-notice");
const KERNEL = `http://127.0.0.1:${ELECTRON_E2E_PORT}`;
// mock「远端新版本」号：只需高于 dev app.getVersion()，语言无关（标题模板插版本号）
const MOCK_VERSION = "9.9.9";

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

/** 主进程侧记录到的 notice:send 载荷（记录版 handler 写入 globalThis.__seen） */
async function interceptedSends(): Promise<Array<Record<string, any>>> {
	return app.evaluate(() => (globalThis as any).__seen ?? []);
}

/** 广播「发现新版本」事件（与 updater.cjs translateUpdaterEvent 的 available 载荷同构） */
async function broadcastUpdateAvailable(version: string): Promise<void> {
	await app.evaluate(({ BrowserWindow }, v) => {
		const w = BrowserWindow.getAllWindows().find(
			(x) =>
				!x.isDestroyed() &&
				(x.webContents.getURL() || "").startsWith("http"),
		);
		w!.webContents.send("updater:event", {
			phase: "available",
			version: v,
			releaseNotes: "E2E mock release notes",
		});
	}, version);
}

/** 模拟通知点击下行（notice.cjs 通知 click 后 webContents.send("notice:action", action)） */
async function sendNoticeAction(action: Record<string, unknown>): Promise<void> {
	await app.evaluate(({ BrowserWindow }, a) => {
		const w = BrowserWindow.getAllWindows().find(
			(x) =>
				!x.isDestroyed() &&
				(x.webContents.getURL() || "").startsWith("http"),
		);
		w!.webContents.send("notice:action", a);
	}, action);
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
	// 等 React mount 完成：App useEffect 已注册 waPiNotice.onAction 与
	// initUpdateNotice 的 store 订阅，此后广播 updater:event 才会触发通知
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

	// 替换 notice:send 为记录版：捕获渲染端发出的完整通知载荷（含 action），
	// 不再弹真实系统通知（见文件头说明 1）
	await app.evaluate(({ ipcMain }) => {
		const im = ipcMain as any;
		im.removeHandler("notice:send");
		(globalThis as any).__seen = [];
		im.handle("notice:send", (_e: unknown, payload: unknown) => {
			(globalThis as any).__seen.push(payload);
			return { sent: true };
		});
	});
});

test.afterAll(async () => {
	await app?.close();
	rmSync(ELECTRON_E2E_DIR, { recursive: true, force: true });
});

test.describe.serial("通知链路（更新通知 + 点击跳转）", () => {
	test("更新可用：自动发出系统通知请求，标题含新版本号且 action 指向更新页", async () => {
		// 前置：尚无任何通知发出
		expect(await interceptedSends()).toHaveLength(0);

		// 广播 available → 渲染端 store → initUpdateNotice 订阅触发 send
		await broadcastUpdateAvailable(MOCK_VERSION);
		await expect
			.poll(interceptedSends, { timeout: 10_000 })
			.toHaveLength(1);

		const [payload] = await interceptedSends();
		// 标题含新版本号（zh「发现新版本 v9.9.9」/ en「New version v9.9.9 available」）
		expect(String(payload.title)).toContain(MOCK_VERSION);
		// body 非空（i18n 文案已在渲染端组装）
		expect(String(payload.body).length).toBeGreaterThan(0);
		// action 形状：整包指向更新页
		expect(payload.action).toEqual({ type: "update" });
		// 更新通知不受前台拦截（无 backgroundOnly），前台也能弹
		expect(payload.backgroundOnly).toBeUndefined();

		// 同自然日至多一条：再次 available 不重复发送（lastUpdateNoticeDate 已记日）
		await broadcastUpdateAvailable(MOCK_VERSION);
		await main.waitForTimeout(600);
		expect(await interceptedSends()).toHaveLength(1);
	});

	test("点击更新通知：打开设置并定位关于页", async () => {
		expect(main.getByTestId("settings-modal")).toHaveCount(0);

		// 模拟通知 click 下行（真实系统通知的 click 不可能被自动化点按）
		await sendNoticeAction({ type: "update" });

		// 设置弹窗打开且「关于」分区激活（about-section 仅在 about 分支渲染）
		await expect(main.getByTestId("settings-modal")).toBeVisible();
		await expect(main.getByTestId("settings-nav-about")).toBeVisible();
		await expect(main.getByTestId("about-section")).toBeVisible();

		// 收尾关弹窗，不影响下一条用例
		await main.getByTestId("settings-close").click();
		await expect(main.getByTestId("settings-modal")).toHaveCount(0);
	});

	test("点击会话通知：跳进对应会话", async () => {
		// 经 kernel REST 准备真实会话（照 e2e/agent-preview-open.spec.ts 的
		// createSessionViaPrompt 先例：prompt POST 返回时会话记录已落盘，
		// 模型调用的错误走 SSE 广播，不影响建会话；前端经 SSE 自动同步列表）
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

		// 模拟通知 click 下行：跳会话
		await sendNoticeAction({ type: "session", sessionId });

		// 会话视图出现（SessionView 渲染即跳转成功）
		await expect(main.getByTestId("session-view")).toBeVisible();
	});
});
