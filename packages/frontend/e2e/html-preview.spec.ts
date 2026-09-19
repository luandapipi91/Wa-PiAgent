// HTML 预览 E2E：文件树双击 .html → 主内容区渲染 iframe；🌐 打开空预览窗口→关闭回会话；
// 预览窗口「代码」按钮 → 弹源码预览弹窗。
// 依赖 global-setup 预置的 e2e-project（cwd=<WA_PI_DIR>/e2e-project，已注册到 projects.json）。
// /preview 路由 allowlist 只放行项目根内的文件，故含相对资源的 html 产物放 <cwd>/dist/ 下。
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_WA_PI_DIR } from "../playwright.config";
import { createSessionViaPrompt, saveProvider } from "./helpers";

// e2e-project 由 global-setup 预置（cwd=E2E_WA_PI_DIR/e2e-project）
const DIST_DIR = join(E2E_WA_PI_DIR, "e2e-project", "dist");

// 预置 html 产物：dist/index.html + 相对资源 app.js/style.css（浏览器打开后相对路径经同源 /preview 加载）。
// global-setup 已启动 kernel 并落盘 projects.json，spec 加载时（worker 内、globalSetup 之后）直接写盘，
// explorer 5s 轮询 + 初始加载都能看到。
const INDEX_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>HTML 预览 E2E</title>
<link rel="stylesheet" href="style.css" />
</head>
<body>
<h1 id="e2e-title">HTML 预览 E2E</h1>
<p>相对脚本注入：</p>
<span id="e2e-script-text">（未加载）</span>
<script src="app.js"></script>
</body>
</html>`;
const APP_JS = `document.getElementById("e2e-script-text").textContent = "相对 js 已加载";`;
const STYLE_CSS = `h1 { color: rgb(1, 2, 3); }`;
mkdirSync(DIST_DIR, { recursive: true });
writeFileSync(join(DIST_DIR, "index.html"), INDEX_HTML, "utf8");
writeFileSync(join(DIST_DIR, "app.js"), APP_JS, "utf8");
writeFileSync(join(DIST_DIR, "style.css"), STYLE_CSS, "utf8");

// 通过 REST 创建一个 e2e-project 会话并返回 id（绕过真实 LLM，与 explorer.spec 同款）
async function createSession(): Promise<string> {
	const session = await createSessionViaPrompt("e2e-proj-1", {
		agentName: "dev",
		text: "e2e",
		model: "test-model",
		sessionId: "s-hp-" + Math.random().toString(36).slice(2),
	});
	return session.id;
}

// 进入会话页（侧栏选 E2E项目 + 点刚建的会话行）
async function openSession(page: Page): Promise<void> {
	await page.goto("/");
	await page.waitForTimeout(2000);
	const sessionId = await createSession();
	await page.getByText("E2E项目").first().click();
	await page.getByTestId(`session-${sessionId}`).click();
	await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 8000 });
}

// 打开右侧文件树 → 展开 dist → 双击 index.html（进入浏览器预览窗口）
async function openHtmlPreview(page: Page): Promise<void> {
	await page.getByTestId("btn-explorer").click();
	await expect(page.getByTestId("explorer-aside")).toBeVisible({
		timeout: 5000,
	});

	const panel = page.locator('[data-testid="explorer-panel"]');
	const distNode = panel.getByText("dist", { exact: true });
	await expect(distNode).toBeVisible({ timeout: 5000 });
	await distNode.click();

	const htmlNode = panel.getByText("index.html", { exact: true });
	await expect(htmlNode).toBeVisible({ timeout: 5000 });
	await htmlNode.dblclick();

	await expect(page.getByTestId("browser-panel")).toBeVisible({ timeout: 5000 });
}

test.describe
	.serial("HTML 预览", () => {
		// 预置假 provider 规避首启 onboarding 向导（modal-overlay 拦截点击）——automation.spec.ts 同款
		test.beforeAll(async () => {
			await saveProvider({
				id: "e2e-html-preview-provider",
				name: "E2E HtmlPreview",
				slug: "e2e_html_preview",
				baseUrl: "http://localhost:9999/v1",
				apiKey: "sk-e2e",
				api: "openai-completions",
				models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
			});
		});

		test("双击文件树里的 .html → 主内容区渲染 iframe（相对 js/css 完整加载）", async ({
			page,
		}) => {
			test.setTimeout(60_000);
			await openSession(page);
			await openHtmlPreview(page);

			// 主内容区被 BrowserPanel 互斥替换，会话视图卸载
			await expect(page.getByTestId("session-view")).toHaveCount(0);

			// iframe 存在（html-preview-iframe），内容区渲染 index.html 的元素
			const iframe = page.getByTestId("html-preview-iframe");
			await expect(iframe).toBeVisible({ timeout: 5000 });
			const frame = page.frameLocator('[data-testid="html-preview-iframe"]');
			await expect(frame.locator("#e2e-title")).toHaveText("HTML 预览 E2E", {
				timeout: 10_000,
			});
			// 相对资源 app.js 已执行（allow-scripts），style.css 请求不 404（内核返回 css）
			await expect(frame.locator("#e2e-script-text")).toHaveText(
				"相对 js 已加载",
				{
					timeout: 10_000,
				},
			);
		});

		test("点 🌐 → 空预览窗口 → 关闭回会话视图", async ({ page }) => {
			test.setTimeout(60_000);
			await openSession(page);

			// 🌐 打开空窗口（无 path）：BrowserPanel 出现、空态可见、无 iframe
			await page.getByTestId("btn-browser-preview").click();
			await expect(page.getByTestId("browser-panel")).toBeVisible({
				timeout: 5000,
			});
			await expect(page.getByTestId("browser-empty")).toBeVisible({
				timeout: 5000,
			});
			await expect(page.getByTestId("html-preview-iframe")).toHaveCount(0);

			// 关闭 → 会话视图恢复、BrowserPanel 卸载
			await page.getByTestId("browser-close").click();
			await expect(page.getByTestId("session-view")).toBeVisible({
				timeout: 5000,
			});
			await expect(page.getByTestId("browser-panel")).toHaveCount(0);
		});

		test("预览窗口点代码按钮 → 弹文件源码预览弹窗", async ({ page }) => {
			test.setTimeout(60_000);
			await openSession(page);
			await openHtmlPreview(page);

			// 点「代码」→ 全局 FilePreviewModal 弹出（FileViewer 渲染 html 源码）
			await page.getByTestId("browser-code").click();
			const modal = page.getByTestId("file-preview-modal");
			await expect(modal).toBeVisible({ timeout: 5000 });
			// 弹窗内展示 index.html 源码内容
			await expect(modal).toContainText("HTML 预览 E2E", { timeout: 10_000 });
		});

		test("文件预览弹窗：点遮罩不关闭，右下角手柄拖动调整大小，ESC 仍关闭", async ({
			page,
		}) => {
			test.setTimeout(60_000);
			await openSession(page);
			await openHtmlPreview(page);

			await page.getByTestId("browser-code").click();
			const modal = page.getByTestId("file-preview-modal");
			await expect(modal).toBeVisible({ timeout: 5000 });

			// 点遮罩（阴影处，视口左上角远离卡片）不关闭弹窗
			await page.getByTestId("modal-overlay").click({ position: { x: 5, y: 5 } });
			await expect(modal).toBeVisible();

			// 右下角手柄拖动 → 窗口变大（初始 80vw×80vh @ 1280×720 = 1024×576）
			const handle = page.getByTestId("modal-resize-handle");
			await expect(handle).toBeVisible();
			const before = (await modal.boundingBox())!;
			await handle.hover();
			await page.mouse.down();
			// 拖 +100/+60（手柄中心在边缘内 7px，净增量 ≈ +93/+53，均在 clamp 上限内）
			await page.mouse.move(
				before.x + before.width + 100,
				before.y + before.height + 60,
				{ steps: 5 },
			);
			await page.mouse.up();
			const after = (await modal.boundingBox())!;
			expect(after.width).toBeGreaterThan(before.width + 80);
			expect(after.height).toBeGreaterThan(before.height + 40);

			// ESC 仍是保留的关闭入口
			await page.keyboard.press("Escape");
			await expect(modal).toHaveCount(0);
		});

		test("预览窗口点分享按钮 → 分享弹窗出现（未配 token 则跳设置分享引导）", async ({
			page,
		}) => {
			test.setTimeout(60_000);
			await openSession(page);
			await openHtmlPreview(page);

			// 点「分享」→ ShareResultModal 挂载检查 token：
			// - 已配置 → 分享弹窗停留（share-result-modal）
			// - 未配置 → 自动跳「设置 → 分享」引导（share-section）
			// E2E 环境不预置分享 token，实际走后者；两者任一出现即断言通过。
			await page.getByTestId("browser-share").click();
			await expect(
				page
					.getByTestId("share-result-modal")
					.or(page.getByTestId("share-section")),
			).toBeVisible({ timeout: 5000 });
		});

		test("预览打开后点侧边栏会话 → 预览窗口自动关闭，回到会话视图", async ({
			page,
		}) => {
			test.setTimeout(60_000);
			await openSession(page);
			await openHtmlPreview(page);

			// 预览窗口已打开、会话视图卸载
			await expect(page.getByTestId("browser-panel")).toBeVisible({
				timeout: 5000,
			});
			await expect(page.getByTestId("session-view")).toHaveCount(0);

			// 点侧边栏会话行 → 预览关闭、会话视图恢复
			const sessionRow = page.locator("[data-testid^='session-']").first();
			await sessionRow.click();
			await expect(page.getByTestId("browser-panel")).toHaveCount(0);
			await expect(page.getByTestId("session-view")).toBeVisible({
				timeout: 5000,
			});
		});
	});
