// 空文字 + 附件直接发送 E2E（第四层）：真实浏览器 + 真实 kernel（隔离 WA_PI_DIR）。
// 回归用户反馈：上传图片附件后必须打字才能发送（前端三道闸：ComposerInput.canSend、
// Composer.handleSend/handleSendSteer、NewSessionPane.handleSend 都硬拦空文本）。
// 现在要求：附件上传完成后，不打字也能直接发送（点击按钮 / 回车），
// kernel buildPromptContent 会为附件拼 Attachments 段，空文字消息天然合法。
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createProject, saveProvider, setUiPrefs, selectModel } from "./helpers";

// 1x1 PNG（最小合法图片，避免依赖外部素材）
const PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// 与 composer-image-attachments.spec 同款：DataTransfer 构造 paste，走真实上传链路
async function pasteImage(page: import("@playwright/test").Page) {
	await page
		.locator('[data-testid="composer-input"] [contenteditable]')
		.evaluate((el, b64) => {
			const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
			const dt = new DataTransfer();
			dt.items.add(new File([bytes], "image.png", { type: "image/png" }));
			el.dispatchEvent(
				new ClipboardEvent("paste", {
					clipboardData: dt,
					bubbles: true,
					cancelable: true,
				}),
			);
		}, PNG_BASE64);
	await expect(page.getByTestId("attachment-list").getByTestId("attachment-chip")).toHaveCount(1, {
		timeout: 20_000,
	});
}

test.describe.serial("空文字 + 附件直接发送", () => {
	test.beforeAll(async () => {
		// 预置假 provider：规避首启 onboarding 向导弹窗拦截交互（发送会失败调 LLM，不影响前端断言）
		await saveProvider({
			id: "e2e-att-only-provider",
			name: "E2E AttOnly",
			slug: "e2e-att-only",
			baseUrl: "http://localhost:9999/v1",
			apiKey: "sk-e2e",
			api: "openai-completions",
			models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
		});
	});

	test("新建页：粘贴图片后不打字，发送按钮可用、点击直接发送", async ({ page }) => {
		test.setTimeout(120_000);
		const projectName = `e2e-att-only-${randomUUID().slice(0, 8)}`;
		const project = await createProject(projectName, `/tmp/${projectName}`);

		await setUiPrefs(page, "zh");
		await page.goto("/");
		await expect(page.getByTestId("new-session-pane")).toBeVisible({
			timeout: 10_000,
		});
		await page.getByTestId("project-select").selectOption(project.id);
		await selectModel(page, { label: "E2E AttOnly/model-a" });

		await pasteImage(page);

		// 核心断言：无文字但有附件 → 发送按钮必须可用（改动前被 canSend 的 text.trim() 拦死）
		const send = page.getByTestId("composer-send");
		await expect(send).toBeEnabled();

		await send.click();

		// 发送成功：切到会话视图、附件区清空（attachment chip 已随消息发出）
		await expect(page.getByTestId("session-view")).toBeVisible({
			timeout: 10_000,
		});
		await expect(page.getByTestId("attachment-list")).not.toBeVisible();
	});

	test("会话页续发：空文字 + 图片 → 乐观用户消息出现", async ({ page }) => {
		test.setTimeout(120_000);
		const projectName = `e2e-att-cont-${randomUUID().slice(0, 8)}`;
		const project = await createProject(projectName, `/tmp/${projectName}`);

		await setUiPrefs(page, "zh");
		await page.goto("/");
		await expect(page.getByTestId("new-session-pane")).toBeVisible({
			timeout: 10_000,
		});
		await page.getByTestId("project-select").selectOption(project.id);
		await selectModel(page, { label: "E2E AttOnly/model-a" });

		// 先用文字消息建会话（走既有路径），进入会话视图
		await page
			.locator('[data-testid="composer-input"] [role="textbox"]')
			.fill("建立会话");
		await page.getByTestId("composer-send").click();
		await expect(page.getByTestId("session-view")).toBeVisible({
			timeout: 10_000,
		});

		// 会话页粘贴图片，不打字，直接点发送（Composer 路径）
		await pasteImage(page);
		const send = page.getByTestId("composer-send");
		await expect(send).toBeEnabled();

		await send.click();

		// 附件区清空 + 消息成功入队：假 provider 下第一轮持续重试（会话运行中），
		// 运行中发送走 followUp 排队（既有语义）——改动前空文字会在入队前就被
		// handleSend 的 !expandedText.trim() 静默拦死，不会出现任何排队条目。
		// 空闲会话的乐观插入路径已由 Composer-send-guard 组件测试覆盖（断言 /prompt POST）。
		await expect(page.getByTestId("attachment-list")).not.toBeVisible();
		// 全量负载下假 provider 重试 + 队列入面板慢，窗口放宽
		await expect(page.getByTestId("queue-panel")).toContainText("附件:image.png", {
			timeout: 30_000,
		});
	});
});
