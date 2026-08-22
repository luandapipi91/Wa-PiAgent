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
		// 向右回拖横穿预览 iframe（回归：iframe 吞事件导致拖拽卡死——
		// 无屏蔽时越过 iframe 边界的 mousemove 全部丢失，宽度几乎不变；此处断言宽度确实回缩）
		const resizer2 = await page.getByTestId("browser-split-resizer").boundingBox();
		await page.mouse.move(resizer2!.x + 1, resizer2!.y + 100);
		await page.mouse.down();
		await page.mouse.move(resizer2!.x + 150, resizer2!.y + 200, { steps: 8 });
		await page.mouse.up();
		const panelAfter2 = await page.getByTestId("browser-panel").boundingBox();
		expect(panelAfter2!.width).toBeLessThan(panelAfter!.width - 100);
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
		// 无标题栏：从工具栏上缘的非交互 padding 区按住拖动（横向取中，避开两侧按钮/输入框）
		await page.mouse.move(before!.x + before!.width / 2, before!.y + 4);
		await page.mouse.down();
		// 默认 rect 锚在视口右缘 40px（store defaultRect），向右拖会被 clampRect 钳住；
		// 改为向左 60 / 向下 60 验证位置跟随
		await page.mouse.move(before!.x + before!.width / 2 - 60, before!.y + 64, {
			steps: 5,
		});
		await page.mouse.up();
		const after = await win.boundingBox();
		expect(Math.abs(after!.x - before!.x + 60)).toBeLessThan(20);
		expect(Math.abs(after!.y - before!.y - 60)).toBeLessThan(20);
		// 第二次拖动：路径大幅下压横穿 iframe 区域（回归：iframe 吞事件导致拖不动/卡死），
		// 拖完后窗口仍应跟随且后续拖拽可用
		await page.mouse.move(after!.x + after!.width / 2, after!.y + 4);
		await page.mouse.down();
		await page.mouse.move(after!.x + after!.width / 2 - 60, after!.y + 104, {
			steps: 10,
		});
		await page.mouse.up();
		const after2 = await win.boundingBox();
		expect(Math.abs(after2!.y - after!.y - 100)).toBeLessThan(30);
		// 浮动时聊天仍在
		await expect(page.getByTestId("session-view")).toBeVisible();
		// 停靠 = 工具栏 split 模式按钮
		await page.getByTestId("browser-mode-split").click();
		await expect(page.getByTestId("browser-split-resizer")).toBeVisible();
	});

	test("浮动模式：最小化为气泡，点击气泡恢复", async ({ page }) => {
		await enterSession(page, "预览最小化测试");
		await openPreview(page);
		await page.getByTestId("browser-mode-float").click();
		await expect(page.getByTestId("float-window")).toBeVisible();
		// 最小化：窗口隐藏（保持挂载）、气泡出现，聊天不受影响
		await page.getByTestId("browser-minimize").click();
		await expect(page.getByTestId("float-window")).toBeHidden();
		await expect(page.getByTestId("float-bubble")).toBeVisible();
		await expect(page.getByTestId("session-view")).toBeVisible();
		// 预览未关闭（浏览器仍开着，只是最小化）
		// 气泡可拖动停放位置（拖完持久化）
		const bubble = page.getByTestId("float-bubble");
		const before = await bubble.boundingBox();
		await page.mouse.move(before!.x + 22, before!.y + 22);
		await page.mouse.down();
		await page.mouse.move(before!.x - 58, before!.y - 58, { steps: 5 });
		await page.mouse.up();
		const after = await bubble.boundingBox();
		expect(Math.abs(after!.x - before!.x + 80)).toBeLessThan(20);
		expect(Math.abs(after!.y - before!.y + 80)).toBeLessThan(20);
		// 持久化（debounce 300ms，等 500ms 后读 localStorage）
		await page.waitForTimeout(500);
		const saved = await page.evaluate(() =>
			JSON.parse(localStorage.getItem("hiagent.browser.bubblePos") ?? "null"),
		);
		expect(Math.abs(saved.x - after!.x)).toBeLessThan(2);
		expect(Math.abs(saved.y - after!.y)).toBeLessThan(2);
		// 点击气泡（无拖动）恢复
		await page.getByTestId("float-bubble").click();
		await expect(page.getByTestId("float-window")).toBeVisible();
		await expect(page.getByTestId("float-bubble")).toHaveCount(0);
	});

	test("元素选中：hover 高亮 → 发送到聊天 → chip 落入输入框", async ({ page }) => {
		await enterSession(page, "元素选中测试");
		await openPreview(page);
		const frame = page.frameLocator('[data-testid="html-preview-iframe"]');
		// hover #card：inspect 工具条出现（hover 命中最深的 <p>，工具条显示元素名 p）
		await frame.locator("#card").hover();
		const sendBtn = frame.getByText("发送到聊天");
		await expect(sendBtn).toBeVisible({ timeout: 5000 });
		await expect(frame.getByText("p", { exact: true })).toBeVisible();
		// 模拟真实鼠标：从元素分步移向工具条（路径穿过元素与工具条之间的间隙，
		// 覆盖"移动中选中被切走导致按钮点不到"的回归）
		const btnBox = await sendBtn.boundingBox();
		await page.mouse.move(
			btnBox!.x + btnBox!.width / 2,
			btnBox!.y + btnBox!.height / 2,
			{ steps: 12 },
		);
		// 选择父级：高亮目标上移（#card 的父级是 body）；工具条元素名更新为 div#card
		await frame.getByText("选择父级").click();
		await expect(frame.getByText("div#card", { exact: true })).toBeVisible();
		// 发送到聊天：元素以 内联 chip 出现在输入框文本流里（非附件栏）
		await sendBtn.click();
		const chip = page.locator('[data-testid="composer-input"] .chip-element');
		await expect(chip).toBeVisible({ timeout: 5000 });
		await expect(chip).toContainText("index.html");
		// 附件栏不出现元素附件
		await expect(page.getByTestId("attachment-chip")).toHaveCount(0);
	});

	test("元素 chip 随消息发送（含行号定位文本）", async ({ page }) => {
		await enterSession(page, "元素发送测试");
		// enterSession 的首条消息让 agent 卡在运行中（假 provider 不回复），
		// 先停止——否则后续消息进队列面板（纯文本），无法断言消息列表 chip 回显
		await page.getByTestId("btn-stop").click();
		await expect(page.getByTestId("btn-stop")).toBeHidden({ timeout: 10000 });
		await openPreview(page);
		// 先输入文本再插入 chip（fill 会整体替换内容，后输入会把 chip 抹掉）
		await page.locator('[data-testid="composer-input"] [role="textbox"]').fill("改这个元素");
		const frame = page.frameLocator('[data-testid="html-preview-iframe"]');
		await frame.locator("#card").hover();
		// hover 命中的是 #card 内最深的 <p>（第 6 行）；先「选择父级」上移高亮到
		// #card（第 5 行 <div>），再发送，chip 才带 index.html:5 定位
		await frame.getByText("选择父级").click();
		await frame.getByText("发送到聊天").click();
		const chip = page.locator('[data-testid="composer-input"] .chip-element');
		await expect(chip).toBeVisible({ timeout: 5000 });
		// chip 带行号（静态文件可定位：index.html:5 <div>）
		await expect(chip).toContainText("index.html:5");
		await page.getByTestId("composer-send").click();
		// 发送后 chip 随文本清空；消息里的定位文本回显为 chip（非纯文本）
		await expect(chip).toHaveCount(0);
		await expect(page.getByText("改这个元素").first()).toBeVisible({ timeout: 8000 });
		const msgChip = page.locator('[data-testid="session-view"] .chip-element').first();
		await expect(msgChip).toBeVisible({ timeout: 8000 });
		await expect(msgChip).toContainText("index.html:5");
	});
});
