import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createProject, saveProvider } from "./helpers";

// 小窗口下 split 半屏预览：工具栏行尾的关闭按钮必须完整可见且可点。
// 回归背景：工具栏单行 nowrap + 地址栏 shrink-0 锁死宽度，面板宽度小于需求总宽时
// flex 行整体向右溢出、被 split 容器 overflow-hidden 裁剪，行尾关闭按钮最先消失。
// 期望行为：窄面板下地址栏先收缩、按钮行兜底换行，关闭按钮始终在视口内可点。
test.describe
	.serial("小窗口半屏预览关闭按钮", () => {
		test.use({ viewport: { width: 900, height: 650 } });

		const projectName = `e2e-narrow-${randomUUID().slice(0, 8)}`;
		const cwd = `/tmp/${projectName}`;

		test.beforeEach(async ({ page }) => {
			await page.goto("/");
			// 预览窗口模式按 origin 存 localStorage（E2E 隔离 WA_PI_DIR 但 localStorage 不隔离），
			// 串行用例间会互相污染默认模式，进页面前先清
			await page.evaluate(() => localStorage.clear());
			await page.goto("/");
			const proj = await createProject(projectName, cwd);
			mkdirSync(cwd, { recursive: true });
			writeFileSync(
				join(cwd, "index.html"),
				[
					"<!DOCTYPE html>",
					"<html>",
					"<head><title>t</title></head>",
					"<body>",
					"<p>hello</p>",
					"</body>",
					"</html>",
				].join("\n"),
			);
			await saveProvider({
				id: "e2e-narrow-provider",
				name: "E2E Narrow",
				slug: "e2e-narrow",
				baseUrl: "http://localhost:9999/v1",
				apiKey: "sk-e2e",
				api: "openai-completions",
				models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
			});
		});

		test.afterAll(() => {
			rmSync(cwd, { recursive: true, force: true });
		});

		test("窄视口下关闭按钮完整可见且可点", async ({ page }) => {
			await page.goto("/");
			await expect(page.getByTestId("new-session-pane")).toBeVisible({
				timeout: 5000,
			});
			await page
				.getByTestId("model-selector")
				.selectOption({ label: "E2E Narrow/model-a" });
			await page
				.locator('[data-testid="composer-input"] [role="textbox"]')
				.fill("窄窗预览测试");
			await page.getByTestId("composer-send").click();
			await expect(page.getByTestId("session-view")).toBeVisible({
				timeout: 5000,
			});
			// 打开预览并加载本地 html
			await page.getByTestId("btn-browser-preview").click();
			await expect(page.getByTestId("browser-panel")).toBeVisible();
			await page.getByTestId("browser-input").fill(`${cwd}/index.html`);
			await page.getByTestId("browser-input").press("Enter");
			await expect(page.getByTestId("html-preview-iframe")).toBeVisible();

			// 关闭按钮完整落在视口内（不被 split 容器 overflow-hidden 裁掉）
			const box = await page.getByTestId("browser-close").boundingBox();
			expect(box).toBeTruthy();
			expect(box!.x).toBeGreaterThanOrEqual(0);
			expect(box!.x + box!.width).toBeLessThanOrEqual(900);
			expect(box!.y + box!.height).toBeLessThanOrEqual(650);
			// 真实可点：playwright click 自带 actionability 检查，点击后面板关闭
			await page.getByTestId("browser-close").click();
			await expect(page.getByTestId("browser-panel")).toBeHidden();
		});
	});
