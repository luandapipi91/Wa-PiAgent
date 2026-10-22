// 「发送给 IM 联系人」E2E：mock 渠道产生联系人 → 主聊天 / 命令 → 弹窗选人 →
// chip 插入 → 发送（标记随消息发给 kernel）→ 刷新后 chip 仍正常渲染（meta 注册回归）。
// agent 自主调用 im_push_to 的推送执行由 kernel 集成测试覆盖（E2E 环境无真实 LLM）。
import { expect, test } from "@playwright/test";
import { E2E_WS_PORT } from "../playwright.config";
import { createProject, saveProvider } from "./helpers";

const KERNEL = `http://127.0.0.1:${E2E_WS_PORT}`;

test.describe("发送给 IM 联系人", () => {
	let channelId: string | null = null;

	test.afterEach(async ({ request }) => {
		if (channelId) await request.delete(`${KERNEL}/api/channels/${channelId}`).catch(() => {});
		channelId = null;
	});

	test("/ 命令 → 选联系人 → chip → 发送 → 刷新后 chip 保留", async ({ page, request }) => {
		test.setTimeout(120_000);
		// 1. mock 渠道 + 进站消息 → 产生联系人（ct_ id）
		const res = await request.post(`${KERNEL}/api/channels`, {
			data: {
				channel: {
					type: "mock",
					name: "E2E-SendIm",
					enabled: true,
					credentials: { botId: "mock-b", secret: "mock-s" },
					agentName: "dev",
					model: null,
					extraSystemPrompt: "",
					replyGranularity: "standard",
				},
			},
		});
		expect(res.ok()).toBeTruthy();
		channelId = ((await res.json()) as any).channels[0].id;
		await request.post(`${KERNEL}/api/channels/${channelId}/mock-inbound`, {
			data: { chatId: "u-sendim", text: "你好" },
		});
		// 等联系人落库
		let contact: any;
		await expect(async () => {
			const r = await request.get(`${KERNEL}/api/contacts`);
			const body = (await r.json()) as any;
			contact = body.contacts?.find((c: any) => c.channelId === channelId);
			expect(contact).toBeTruthy();
		}).toPass({ timeout: 10_000 });

		// 2. 项目 + 假 provider + 打开主聊天（新建会话直接可用：命令不因 isNewSession 禁用）
		const project = await createProject("e2e-send-im", "/tmp/e2e-send-im");
		await saveProvider({
			id: "e2e-sendim-provider",
			name: "E2E SendIm",
			slug: "e2e-sendim",
			baseUrl: "http://localhost:9999/v1",
			apiKey: "sk-e2e",
			api: "openai-completions",
			models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
		});
		await page.goto("/");
		await page.getByTestId("project-select").selectOption(project.id);
		await page.getByTestId("model-selector").selectOption({ label: "E2E SendIm/model-a" });
		await page.getByTestId("thinking-selector").selectOption("disabled");
		const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');

		// 3. 新建会话直接输入 / → 选中「发送给 IM 联系人」→ 弹窗选人 → 确认
		//（命令不再因 isNewSession 禁用：推送走全局执行器，不依赖会话状态）
		await textbox.fill("/");
		const menu = page.getByTestId("quick-invoke-menu");
		await expect(menu).toBeVisible({ timeout: 5000 });
		await menu.getByText("发送给 IM 联系人").click();
		const dialog = page.getByTestId("contact-picker-dialog");
		await expect(dialog).toBeVisible({ timeout: 5000 });
		await dialog.getByTestId(`contact-picker-item-${contact.id}`).click();
		await dialog.getByTestId("contact-picker-ok").click();

		// 4. chip 出现在输入框（data-token 为 @im-push-to 标记，联系人无 remark 时显示 userId）
		const chip = page.locator('[data-testid="composer-input"] .chip-im');
		await expect(chip).toBeVisible({ timeout: 3000 });
		await expect(chip).toHaveAttribute(
			"data-token",
			`@im-push-to(${channelId},${contact.id})`,
		);

		// 5. 输入任务并发送 → 用户气泡回显 chip（标记原样发给 kernel，不展开）
		await textbox.pressSequentially("总结一下今天的工作");
		await page.getByTestId("composer-send").click();
		const echoChip = page.locator('[data-testid="session-view"] .chip-im').first();
		await expect(echoChip).toBeVisible({ timeout: 8000 });

		// 6. 刷新页面 → 历史消息 chip 仍正常渲染（联系人 meta 由 loadContacts 注册，不灰化）
		await page.reload();
		// 刷新后应用回到默认视图，需点击会话行重新打开（会话标题 = 首条消息的 chip token）
		const row = page
			.locator('[data-testid^="session-"]')
			.filter({ hasText: "@im-push-to(" })
			.first();
		await expect(row).toBeVisible({ timeout: 10_000 });
		await row.click();
		await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 10_000 });
		const historyChip = page.locator('[data-testid="session-view"] .chip-im').first();
		await expect(historyChip).toBeVisible({ timeout: 8000 });
		await expect(historyChip).not.toHaveClass(/chip-im-invalid/);
	});
});
