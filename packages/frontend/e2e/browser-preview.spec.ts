import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createProject, saveProvider } from "./helpers";

// 浏览器预览：分屏/全屏/浮动 + 本地 html 元素选中 chip
test.describe.serial("浏览器预览与元素选中", () => {
	const projectName = `e2e-preview-${randomUUID().slice(0, 8)}`;
	const cwd = `/tmp/${projectName}`;

	test.beforeEach(async ({ page }) => {
		await page.goto("/");
		// 预览窗口模式按 origin 存 localStorage（E2E 隔离 WA_PI_DIR 但 localStorage 不隔离），
		// 串行用例间会互相污染默认模式，进页面前先清
		await page.evaluate(() => localStorage.clear());
		await page.goto("/");
		await createProject(projectName, cwd);
		mkdirSync(cwd, { recursive: true });
		writeFileSync(
			join(cwd, "index.html"),
			[
				"<!DOCTYPE html>",
				"<html>",
				"<head><title>t</title></head>",
				"<body>",
				'<div id="card">',
				"  <p>hello</p>",
				"</div>",
				"</body>",
				"</html>",
			].join("\n"),
		);
		await saveProvider({
			id: "e2e-preview-provider",
			name: "E2E Preview",
			slug: "e2e-preview",
			baseUrl: "http://localhost:9999/v1",
			apiKey: "sk-e2e",
			api: "openai-completions",
			models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
		});
	});

	test.afterAll(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	// 进入 session 视图（与 composer.spec.ts 同款 helper）
	async function enterSession(
		page: import("@playwright/test").Page,
		text: string,
	): Promise<void> {
		await page.goto("/");
		await expect(page.getByTestId("new-session-pane")).toBeVisible({ timeout: 5000 });
		await page
			.getByTestId("model-selector")
			.selectOption({ label: "E2E Preview/model-a" });
		await page.locator('[data-testid="composer-input"] [role="textbox"]').fill(text);
		await page.getByTestId("composer-send").click();
		await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 5000 });
	}

	// 打开预览并加载本地 html
	// 注意：地址栏用 POSIX 斜杠拼路径（join 在 Windows 产出 \tmp\...，前端 openPath
	// 的绝对路径判定不认 \ 开头的 rooted 路径，会当非法路径拒绝）；Node 侧写文件仍用 join
	async function openPreview(page: import("@playwright/test").Page): Promise<void> {
		await page.getByTestId("btn-browser-preview").click();
		await expect(page.getByTestId("browser-panel")).toBeVisible();
		await page.getByTestId("browser-input").fill(`${cwd}/index.html`);
		await page.getByTestId("browser-input").press("Enter");
		await expect(page.getByTestId("html-preview-iframe")).toBeVisible();
	}

	test("split 模式：聊天与预览并存，拖分隔条改比例", async ({ page }) => {
		await enterSession(page, "预览分屏测试");
		await openPreview(page);
		// 并存：会话视图不被卸载
		await expect(page.getByTestId("session-view")).toBeVisible();
		await expect(page.getByTestId("browser-split-resizer")).toBeVisible();
		const panelBefore = await page.getByTestId("browser-panel").boundingBox();
		const resizer = await page.getByTestId("browser-split-resizer").boundingBox();
		// 向左拖 150px：预览变宽
		await page.mouse.move(resizer!.x + 1, resizer!.y + 100);
		await page.mouse.down();
		await page.mouse.move(resizer!.x - 150, resizer!.y + 100, { steps: 5 });
		await page.mouse.up();
		const panelAfter = await page.getByTestId("browser-panel").boundingBox();
		expect(panelAfter!.width).toBeGreaterThan(panelBefore!.width + 100);
	});

	test("全屏/分屏模式切换", async ({ page }) => {
		await enterSession(page, "预览全屏测试");
		await openPreview(page);
		await page.getByTestId("browser-mode-full").click();
		await expect(page.getByTestId("session-view")).toBeHidden();
		await expect(page.getByTestId("browser-panel")).toBeVisible();
		await page.getByTestId("browser-mode-split").click();
		await expect(page.getByTestId("session-view")).toBeVisible();
	});

	test("浮动模式：拖动位置、停靠回分屏", async ({ page }) => {
		await enterSession(page, "预览浮动测试");
		await openPreview(page);
		await page.getByTestId("browser-mode-float").click();
		const win = page.getByTestId("float-window");
		await expect(win).toBeVisible();
		const before = await win.boundingBox();
		const bar = await page.getByTestId("float-titlebar").boundingBox();
		await page.mouse.move(bar!.x + 100, bar!.y + 8);
		await page.mouse.down();
		// 默认 rect 锚在视口右缘 40px（store defaultRect），向右拖会被 clampRect 钳住；
		// 改为向左 60 / 向下 60 验证位置跟随
		await page.mouse.move(bar!.x + 40, bar!.y + 68, { steps: 5 });
		await page.mouse.up();
		const after = await win.boundingBox();
		expect(Math.abs(after!.x - before!.x + 60)).toBeLessThan(20);
		expect(Math.abs(after!.y - before!.y - 60)).toBeLessThan(20);
		// 浮动时聊天仍在
		await expect(page.getByTestId("session-view")).toBeVisible();
		await page.getByTestId("float-dock").click();
		await expect(page.getByTestId("browser-split-resizer")).toBeVisible();
	});

	test("元素选中：hover 高亮 → 发送到聊天 → chip 落入输入框", async ({ page }) => {
		await enterSession(page, "元素选中测试");
		await openPreview(page);
		const frame = page.frameLocator('[data-testid="html-preview-iframe"]');
		// hover #card：inspect 工具条出现
		await frame.locator("#card").hover();
		await expect(frame.getByText("发送到聊天")).toBeVisible({ timeout: 5000 });
		// 选择父级：高亮目标上移（#card 的父级是 body）
		await frame.getByText("选择父级").click();
		// 发送到聊天：chip 落入输入框附件区
		await frame.getByText("发送到聊天").click();
		await expect(page.getByTestId("attachment-chip")).toBeVisible({ timeout: 5000 });
		await expect(page.getByTestId("attachment-chip")).toContainText("index.html");
		// chip 可删除
		await page.getByTestId("attachment-remove").click();
		await expect(page.getByTestId("attachment-chip")).toBeHidden();
	});

	test("元素 chip 随消息发送（含行号定位文本）", async ({ page }) => {
		await enterSession(page, "元素发送测试");
		await openPreview(page);
		const frame = page.frameLocator('[data-testid="html-preview-iframe"]');
		await frame.locator("#card").hover();
		// hover 命中的是 #card 内最深的 <p>（第 6 行）；先「选择父级」上移高亮到
		// #card（第 5 行 <div>），再发送，chip 才带 index.html:5 定位
		await frame.getByText("选择父级").click();
		await frame.getByText("发送到聊天").click();
		await expect(page.getByTestId("attachment-chip")).toBeVisible({ timeout: 5000 });
		// chip 带行号（静态文件可定位：index.html:5 <div>）
		await expect(page.getByTestId("attachment-chip")).toContainText("index.html:5");
		await page.locator('[data-testid="composer-input"] [role="textbox"]').fill("改这个元素");
		await page.getByTestId("composer-send").click();
		// 发送后附件清空、消息出现在列表
		await expect(page.getByTestId("attachment-list")).toBeHidden();
		await expect(page.getByText("改这个元素").first()).toBeVisible({ timeout: 8000 });
	});
});
