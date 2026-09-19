import {
	test,
	expect,
	_electron as electron,
	type ElectronApplication,
	type Page,
} from "@playwright/test";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import {
	ELECTRON_E2E_DIR,
	ELECTRON_E2E_PORT,
} from "../playwright.electron.config";

// 浮动模式的承载是**真实系统窗口**，只有跑起真 Electron 才能验：
// 窗口是否无边框、是否随最小化隐藏、跨窗口的元素选中能否回到主窗口的聊天框。
// 浏览器 E2E（e2e/）覆盖宿主渲染层，这里覆盖窗口层。

const APP_CWD = join(import.meta.dirname, "..", "..", "desktop");
const PROJECT_DIR = join(ELECTRON_E2E_DIR, "proj");
const HTML_PATH = join(PROJECT_DIR, "index.html");

/** 预览窗口 URL 标记：与前端 preview-window.ts 的 PREVIEW_WIN_PARAM 对应 */
const PREVIEW_WIN_MARK = "wa-preview-win=1";

/** E2E 的 Electron 环境变量。
 *  必须剥离全部继承来的 WA_PI_*：宿主（已安装的桌面端）会设 WA_PI_WEB_DIR，
 *  指向 /Applications/…/Resources/web 的**旧前端**，会让本次 Electron 加载已安装版
 *  而不是仓库源码构建的 dist（曾表现为新功能完全不生效）；
 *  WA_PI_WS_PORT / WA_PI_BRIDGE_* 同理会把 kernel 指向宿主实例。 */
function e2eEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		// 滤掉 undefined（electron.launch 的 env 只接受 string）与宿主的 WA_PI_*
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

/** 轮询找窗口：新建窗口的 window 事件在 loadURL 前就触发（此时 url 还是 about:blank），
 *  用事件 predicate 会漏掉，故按 url 轮询。 */
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

const findPreviewWindow = () => findWindow((u) => u.includes(PREVIEW_WIN_MARK));

/** 主进程视角的窗口状态：可见性与「是否无边框」只能在主进程侧拿 */
async function windowStates() {
	return app.evaluate(({ BrowserWindow }) =>
		BrowserWindow.getAllWindows().map((w) => ({
			url: w.webContents.getURL(),
			visible: w.isVisible(),
			bounds: w.getBounds(),
			content: w.getContentBounds(),
		})),
	);
}

const previewWindowState = async () =>
	(await windowStates()).find((s) => s.url.includes(PREVIEW_WIN_MARK));

/** 关闭首次启动向导：隔离环境默认无 provider，App 自动弹向导（modal-overlay）遮住预览入口 */
async function dismissOnboarding(page: Page) {
	const close = page.getByTestId("onboarding-wizard-close");
	if (await close.isVisible().catch(() => false)) {
		await close.click();
		await expect(page.getByTestId("onboarding-wizard")).toHaveCount(0);
	}
}

/** 确保处于「浮动模式 + 预览已加载」并返回独立窗口。
 *  注意：模式是持久化的全局偏好，上一条用例可能把它停在 float；
 *  此时点预览入口会让预览**直接进独立窗口**（主窗口不会出现面板），
 *  所以两条路径都要兼容。 */
async function ensureFloatPreview(): Promise<Page> {
	const existing = app.windows().find((w) => w.url().includes(PREVIEW_WIN_MARK));
	if (existing) return existing;

	if ((await main.getByTestId("browser-panel").count()) === 0) {
		await main.getByTestId("btn-browser-preview").click();
	}
	// 主窗口有面板（split/full 模式）：就地加载内容再切浮动
	if (await main.getByTestId("browser-panel").count()) {
		if ((await main.getByTestId("html-preview-iframe").count()) === 0) {
			await main.getByTestId("browser-input").fill(HTML_PATH);
			await main.getByTestId("browser-input").press("Enter");
			await expect(main.getByTestId("html-preview-iframe")).toBeVisible();
		}
		await main.getByTestId("browser-mode-float").click();
	}
	const preview = await findPreviewWindow();
	// 浮动模式下的空预览（无 path）：在独立窗口里补上内容
	if ((await preview.getByTestId("html-preview-iframe").count()) === 0) {
		await preview.getByTestId("browser-input").fill(HTML_PATH);
		await preview.getByTestId("browser-input").press("Enter");
		await expect(preview.getByTestId("html-preview-iframe")).toBeVisible();
	}
	return preview;
}

/** 独立的本地目标站点（与前端不同源，模拟用户/agent 打开的 dev server 页面） */
async function startTargetServer(): Promise<{
	url: string;
	close: () => Promise<void>;
}> {
	const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" /><title>electron 目标页</title></head>
<body><h1 id="electron-preview-target">electron 目标页已加载</h1></body></html>`;
	const server = createServer((_req, res) => {
		res.setHeader("content-type", "text/html; charset=utf-8");
		res.end(html);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;
	return {
		url: `http://127.0.0.1:${port}/`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

test.beforeAll(async () => {
	// 隔离目录从零开始：上轮残留的窗口位置/预览记忆会干扰断言
	rmSync(ELECTRON_E2E_DIR, { recursive: true, force: true });
	mkdirSync(PROJECT_DIR, { recursive: true });
	writeFileSync(
		HTML_PATH,
		[
			"<!DOCTYPE html>",
			"<html>",
			"<head><title>e2e electron</title></head>",
			"<body>",
			'<div id="card">',
			"  <p>hello</p>",
			"</div>",
			"</body>",
			"</html>",
		].join("\n"),
	);

	app = await electron.launch({
		// user-data-dir 隔离 Electron 单例锁：用户正开着桌面端时也能跑
		args: [".", `--user-data-dir=${join(ELECTRON_E2E_DIR, "userdata")}`],
		cwd: APP_CWD,
		env: e2eEnv(),
	});

	// 主窗口（kernel 静态服务）；splash 是 data: URL，会被关闭，故按 http 前缀找
	main = await findWindow((u) => u.startsWith("http://127.0.0.1:"), 120_000);
	await main.waitForSelector('[data-testid="new-session-pane"]', {
		timeout: 120_000,
	});
	// 建项目（REST）：前端经 SSE 的 projects:list 自动刷新，预览入口随之出现
	const res = await fetch(`http://127.0.0.1:${ELECTRON_E2E_PORT}/api/projects`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ name: "e2e-electron-preview", cwd: PROJECT_DIR }),
	});
	expect(res.ok).toBe(true);
	// 预置假 provider：无 provider 时前端会自动弹首次启动向导，遮住预览入口
	// （与浏览器 E2E 的 ask-stale/automation 同一套规避手法）
	await fetch(`http://127.0.0.1:${ELECTRON_E2E_PORT}/api/providers`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			provider: {
				id: "e2e-electron-provider",
				name: "E2E Electron",
				slug: "e2e-electron",
				baseUrl: "http://localhost:9999/v1",
				apiKey: "sk-e2e",
				api: "openai-completions",
				models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
			},
		}),
	});
	// 向导可能已在 provider 到达前弹出：直接关掉它（关闭后 providers 非空不会再弹）
	await dismissOnboarding(main);
	await expect(main.getByTestId("btn-browser-preview")).toBeVisible();
});

test.afterAll(async () => {
	await app?.close();
	rmSync(ELECTRON_E2E_DIR, { recursive: true, force: true });
});

test.describe
	.serial("浮动预览由独立系统窗口承载", () => {
		test("默认无历史偏好：打开预览直接进独立窗口（默认浮窗）", async () => {
			await main.getByTestId("btn-browser-preview").click();

			// 默认模式是浮动（独立窗口承载）：主窗口不渲染预览面板，也没有旧的内嵌浮层
			await expect(main.getByTestId("browser-panel")).toHaveCount(0);
			await expect(main.getByTestId("float-window")).toHaveCount(0);

			const preview = await findPreviewWindow();
			await preview.waitForSelector('[data-testid="browser-panel"]');
			// 空预览：在独立窗口里加载本地 html
			await preview.getByTestId("browser-input").fill(HTML_PATH);
			await preview.getByTestId("browser-input").press("Enter");
			const iframe = preview.getByTestId("html-preview-iframe");
			await expect(iframe).toBeVisible();
			// 预览 iframe 指向 kernel /preview 路由
			expect(await iframe.getAttribute("src")).toContain("/preview/");

			const state = await previewWindowState();
			expect(state?.visible).toBe(true);
			// 无边框自绘：无系统标题栏时内容区高度 == 窗口高度
			expect(state?.content.height).toBe(state?.bounds.height);
		});

		test("最小化：窗口隐藏收成主窗口气泡；点气泡恢复显示", async () => {
			const preview = await ensureFloatPreview();
			await preview.getByTestId("browser-minimize").click();

			// 窗口隐藏（主进程视角）
			await expect
				.poll(async () => (await previewWindowState())?.visible, {
					timeout: 10_000,
				})
				.toBe(false);
			// 主窗口出现恢复入口，且聊天不受影响
			const bubble = main.getByTestId("float-bubble");
			await expect(bubble).toBeVisible();
			await expect(main.getByTestId("new-session-pane")).toBeVisible();

			await bubble.click();
			await expect
				.poll(async () => (await previewWindowState())?.visible, {
					timeout: 10_000,
				})
				.toBe(true);
			await expect(main.getByTestId("float-bubble")).toHaveCount(0);
		});

		test("独立窗口内切回分屏：窗口关闭，预览回到主窗口内嵌", async () => {
			const preview = await ensureFloatPreview();
			// 先确保有内容（上一条用例只最小化/恢复，内容仍在）
			await expect(preview.getByTestId("html-preview-iframe")).toBeVisible();

			await preview.getByTestId("browser-mode-split").click();

			await expect(main.getByTestId("browser-split-resizer")).toBeVisible();
			await expect(main.getByTestId("html-preview-iframe")).toBeVisible();
			await expect
				.poll(async () => Boolean(await previewWindowState()), { timeout: 10_000 })
				.toBe(false);
		});

		test("元素选中：独立窗口选中的元素 chip 落入主窗口聊天输入框", async () => {
			const preview = await ensureFloatPreview();
			const frame = preview.frameLocator('[data-testid="html-preview-iframe"]');
			await frame.locator("#card").hover();
			const sendBtn = frame.getByText("发送到聊天");
			await expect(sendBtn).toBeVisible();
			await sendBtn.click();

			// 跨窗口回传：chip 出现在**主窗口**的聊天输入框
			const chip = main.locator('[data-testid="composer-input"] .chip-element');
			await expect(chip).toBeVisible();
			await expect(chip).toContainText("index.html");
		});

		test("独立窗口内点分享：激活主窗口（最小化则恢复）并在主窗口打开设置分享分区", async () => {
			const preview = await ensureFloatPreview();
			const mainStateOf = () =>
				app.evaluate(({ BrowserWindow }) => {
					const m = BrowserWindow.getAllWindows().find(
						(w) => !w.webContents.getURL().includes("wa-preview-win"),
					);
					return m ? { visible: m.isVisible(), minimized: m.isMinimized() } : null;
				});
			// 先把主窗口最小化：需要配置分享时应当把它恢复并带到前台
			await app.evaluate(({ BrowserWindow }) => {
				BrowserWindow.getAllWindows()
					.find((w) => !w.webContents.getURL().includes("wa-preview-win"))
					?.minimize();
			});
			await expect.poll(async () => (await mainStateOf())?.minimized).toBe(true);

			await preview.getByTestId("browser-share").click();

			// 设置在**主窗口**打开（数据都在主窗口），独立窗口不重复渲染设置弹窗
			await expect(main.getByTestId("settings-modal")).toBeVisible();
			await expect(main.getByTestId("share-section")).toBeVisible();
			await expect(preview.getByTestId("settings-modal")).toHaveCount(0);
			// 主窗口已从最小化恢复且可见
			await expect.poll(async () => (await mainStateOf())?.minimized).toBe(false);
			expect((await mainStateOf())?.visible).toBe(true);

			// 收尾关掉：modal 会遮挡后续用例的点击/拖动（serial 共享同一实例）
			await main.getByTestId("settings-close").click();
			await expect(main.getByTestId("settings-modal")).toHaveCount(0);
		});

		test("右下角手柄拖拽 → 经 IPC 放大窗口（原生尺寸由主进程执行）", async () => {
			const preview = await ensureFloatPreview();
			const before = (await previewWindowState())!.bounds;
			// 用合成鼠标事件给出手柄拖拽：目标 client 坐标故意越过当前视口边界（窗口会随拖动变大）。
			// 不用真实指针串行：窗口不在前台时指针越界坐标会被裁剪，拖不动（且“拖出窗口”
			// 本来就是手柄的正常用法）。
			await preview.evaluate(() => {
				const handle = document.querySelector(
					'[data-testid="preview-window-resize"]',
				) as HTMLElement;
				const r = handle.getBoundingClientRect();
				const mk = (type: string, x: number, y: number) =>
					new MouseEvent(type, {
						bubbles: true,
						clientX: x,
						clientY: y,
						screenX: x + window.screenX,
						screenY: y + window.screenY,
					});
				handle.dispatchEvent(mk("mousedown", r.left + 5, r.top + 5));
				window.dispatchEvent(
					mk("mousemove", window.innerWidth + 200, window.innerHeight + 150),
				);
				window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
			});
			await expect
				.poll(async () => (await previewWindowState())!.bounds.width, {
					timeout: 10_000,
				})
				.toBeGreaterThan(before.width + 100);
			const after = (await previewWindowState())!.bounds;
			expect(after.height).toBeGreaterThan(before.height + 60);
		});

		test("关闭：独立窗口消失，预览关闭且主窗口不残留面板", async () => {
			const preview = await ensureFloatPreview();
			await preview.getByTestId("browser-close").click();

			await expect
				.poll(async () => Boolean(await previewWindowState()), { timeout: 10_000 })
				.toBe(false);
			await expect(main.getByTestId("browser-panel")).toHaveCount(0);
			// 关闭后主窗口仍在（应用不退出）
			expect(await main.getByTestId("new-session-pane").isVisible()).toBe(true);
		});

		test("独立窗口里输入网址 → 切回分屏后主窗口显示同一网址", async () => {
			const preview = await ensureFloatPreview();
			const target = await startTargetServer();
			try {
				const input = preview.getByTestId("browser-input");
				await input.fill(target.url);
				await input.press("Enter");
				// 本窗口真实加载该网址
				const frame = preview.frameLocator(
					'[data-testid="html-preview-iframe"]',
				);
				await expect(frame.locator("#electron-preview-target")).toHaveText(
					"electron 目标页已加载",
					{ timeout: 15_000 },
				);

				// 切回主窗口内嵌：面板显示同一网址（独立窗口 → 主窗口的 url 同步）
				await preview.getByTestId("browser-mode-split").click();
				await expect(main.getByTestId("browser-panel")).toBeVisible({
					timeout: 10_000,
				});
				await expect(main.getByTestId("browser-input")).toHaveValue(
					target.url,
					{ timeout: 10_000 },
				);
				const mainFrame = main.frameLocator(
					'[data-testid="html-preview-iframe"]',
				);
				await expect(mainFrame.locator("#electron-preview-target")).toHaveText(
					"electron 目标页已加载",
					{ timeout: 15_000 },
				);
			} finally {
				await target.close();
			}
		});

		// 站点用 CSP frame-ancestors 拒绝被嵌入：预览无从显示，应自动改用应用内浏览器窗口
		// （依赖真实网络访问 baidu.com；该站点对嵌入请求下发 frame-ancestors 白名单）
		test("预览被站点拒绝嵌入 → 自动改用应用内浏览器窗口打开", async () => {
			test.setTimeout(90_000);
			const preview = await ensureFloatPreview();
			const input = preview.getByTestId("browser-input");
			await input.fill("https://www.baidu.com/s?wd=%E9%BE%99%E8%99%BE");
			await input.press("Enter");

			// 主窗口先给出去向提示（toast 3s 自动消失，须在等窗口之前断言）
			// 文案随 UI 语言（E2E 未强制 locale，中文系统上为中文）
			await expect(
				main.getByText(/blocks embedding|禁止被嵌入/),
			).toBeVisible({
				timeout: 20_000,
			});

			// 新增一个真窗口承载该网址（顶级导航，不受 frame-ancestors 约束）
			await expect
				.poll(
					async () =>
						await app.evaluate(({ webContents }) =>
							webContents
								.getAllWebContents()
								.some((wc) => wc.getURL().includes("baidu.com/s?wd=")),
						),
					{ timeout: 40_000 },
				)
				.toBe(true);

			// iframe 预览无内容可显示：收场关闭独立预览窗口
			await expect
				.poll(async () => Boolean(await previewWindowState()), {
					timeout: 15_000,
				})
				.toBe(false);
		});

		// 会话界面内嵌预览（分屏）里打开禁止嵌入的网址：走的是主窗口 webContents 的
		// did-fail-load 接线（上一条走的是独立预览窗口那条）——同样是真实站点 + 真实降级
		test("会话界面内嵌预览打开禁止嵌入的网址 → 自动改用应用内浏览器窗口", async () => {
			test.setTimeout(90_000);
			// 从浮动窗口切回会话界面内嵌分屏（浏览器预览与聊天并排）
			const preview = await ensureFloatPreview();
			await preview.getByTestId("browser-mode-split").click();
			await expect(main.getByTestId("browser-panel")).toBeVisible({
				timeout: 10_000,
			});

			const input = main.getByTestId("browser-input");
			await input.fill("https://www.baidu.com/s?wd=%E9%BE%99%E8%99%BE");
			await input.press("Enter");

			// 提示去向 + 真窗口真正加载该页（顶级导航不受 frame-ancestors 约束）
			await expect(
				main.getByText(/blocks embedding|禁止被嵌入/),
			).toBeVisible({ timeout: 20_000 });
			await expect
				.poll(
					async () =>
						await app.evaluate(({ webContents }) =>
							webContents
								.getAllWebContents()
								.some((wc) => wc.getURL().includes("baidu.com/s?wd=")),
						),
					{ timeout: 40_000 },
				)
				.toBe(true);

			// 内嵌预览无内容可显示：会话界面收起预览面板（主内容区恢复——本 E2E 未建会话，回新建页）
			await expect(main.getByTestId("browser-panel")).toHaveCount(0, {
				timeout: 15_000,
			});
			await expect(main.getByTestId("new-session-pane")).toBeVisible();
		});

		// 放在最后：打开的弹窗会遮住后续用例的点击，这里不再收尾
		test("独立窗口内点「查看源码」：源码弹窗在**本窗口**渲染", async () => {
			const preview = await ensureFloatPreview();
			await preview.getByTestId("browser-code").click();
			await expect(preview.getByTestId("file-preview-modal")).toBeVisible();
		});

		// 跨窗口网址同步（预置至最后：会切回分屏，改变后续用例的模式前提）
	});
