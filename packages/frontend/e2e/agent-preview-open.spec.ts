// agent 打开预览 E2E：kernel 广播 preview:open（preview_open 工具触发）后，
// 浏览器里的 HTML 预览真的弹出并加载目标页面。
//
// 触发方式：E2E 测试钩子 window.__PI_E2E_EVENT__（events.ts 仅在 DEV 构建挂载，
// 与真实 SSE 帧走同一条 dispatch 主路径）注入一帧 preview:open 事件——
// kernel 侧「工具调用 → POST /bridge/tool → 广播 preview:open → SSE」链路由
// kernel 集成测试覆盖（packages/kernel/tests/preview-tools.test.ts），
// 本 spec 负责浏览器里的真实展示结果。
import { test, expect, type Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_WA_PI_DIR } from "../playwright.config";
import { createSessionViaPrompt, saveProvider } from "./helpers";

// e2e-project 由 global-setup 预置（cwd=E2E_WA_PI_DIR/e2e-project）
const DIST_DIR = join(E2E_WA_PI_DIR, "e2e-project", "dist");
const TARGET_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8" /><title>agent 预览目标页</title></head>
<body><h1 id="agent-preview-target">agent 预览目标页已加载</h1></body></html>`;
mkdirSync(DIST_DIR, { recursive: true });
writeFileSync(join(DIST_DIR, "agent-preview.html"), TARGET_HTML, "utf8");

/** 独立的本地目标站点（与前端不同源，模拟 agent 打开的 dev server 页面） */
async function startTargetServer(): Promise<{ url: string; close: () => Promise<void> }> {
	const server: Server = createServer((_req, res) => {
		res.setHeader("content-type", "text/html; charset=utf-8");
		res.end(TARGET_HTML);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const addr = server.address();
	const port = typeof addr === "object" && addr ? addr.port : 0;
	return {
		url: `http://127.0.0.1:${port}/`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

/** 建会话并进入会话页（返回会话 id，作为事件归属会话） */
async function openSession(page: Page): Promise<string> {
	await page.goto("/");
	await page.waitForTimeout(2000);
	const session = await createSessionViaPrompt("e2e-proj-1", {
		agentName: "dev",
		text: "e2e",
		model: "test-model",
		sessionId: "s-apo-" + Math.random().toString(36).slice(2),
	});
	await page.getByText("E2E项目").first().click();
	await page.getByTestId(`session-${session.id}`).click();
	await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 8000 });
	return session.id;
}

/** 注入一帧 preview:open（与 kernel SSE 广播同构） */
async function emitPreviewOpen(
	page: Page,
	event: Record<string, unknown>,
): Promise<void> {
	await page.evaluate((e) => {
		(window as any).__PI_E2E_EVENT__(e);
	}, event as any);
}

test.describe
	.serial("agent 打开预览", () => {
		// 预置假 provider 规避首启 onboarding 向导（modal-overlay 拦截点击）
		test.beforeAll(async () => {
			await saveProvider({
				id: "e2e-agent-preview-provider",
				name: "E2E AgentPreview",
				slug: "e2e_agent_preview",
				baseUrl: "http://localhost:9999/v1",
				apiKey: "sk-e2e",
				api: "openai-completions",
				models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
			});
		});

		test("preview:open(url) → 预览面板弹出并真实加载该网址", async ({
			page,
		}) => {
			test.setTimeout(60_000);
			const target = await startTargetServer();
			try {
				const sessionId = await openSession(page);
				// 注入前：没有预览面板
				await expect(page.getByTestId("browser-panel")).toHaveCount(0);

				await emitPreviewOpen(page, {
					type: "preview:open",
					sessionId,
					target: { kind: "url", url: target.url },
				});

				// 主内容区被预览面板替换，iframe 真实加载目标站点
				await expect(page.getByTestId("browser-panel")).toBeVisible({
					timeout: 5000,
				});
				const iframe = page.getByTestId("html-preview-iframe");
				await expect(iframe).toHaveAttribute("src", target.url, {
					timeout: 5000,
				});
				const frame = page.frameLocator(
					'[data-testid="html-preview-iframe"]',
				);
				await expect(frame.locator("#agent-preview-target")).toHaveText(
					"agent 预览目标页已加载",
					{ timeout: 10_000 },
				);
				// 地址栏回填该网址
				await expect(page.getByTestId("browser-input")).toHaveValue(
					target.url,
				);
			} finally {
				await target.close();
			}
		});

		test("preview:open(local path) → 预览面板加载项目内 html", async ({
			page,
		}) => {
			test.setTimeout(60_000);
			const sessionId = await openSession(page);
			const htmlPath = join(DIST_DIR, "agent-preview.html");

			await emitPreviewOpen(page, {
				type: "preview:open",
				sessionId,
				target: { kind: "local", path: htmlPath },
			});

			await expect(page.getByTestId("browser-panel")).toBeVisible({
				timeout: 5000,
			});
			// 本地路径走同源 /preview 路由，iframe 渲染出文件内容
			const frame = page.frameLocator('[data-testid="html-preview-iframe"]');
			await expect(frame.locator("#agent-preview-target")).toHaveText(
				"agent 预览目标页已加载",
				{ timeout: 10_000 },
			);
		});

		test("preview:open 属于非当前会话 → 不抢当前画面，切回该会话后恢复", async ({
			page,
		}) => {
			test.setTimeout(60_000);
			await openSession(page);

			await emitPreviewOpen(page, {
				type: "preview:open",
				sessionId: "s-not-current-" + Math.random().toString(36).slice(2),
				target: { kind: "url", url: "https://example.com/other" },
			});

			// 当前画面不被抢占
			await expect(page.getByTestId("browser-panel")).toHaveCount(0);
			await expect(page.getByTestId("session-view")).toBeVisible();
		});
	});
