// IM 会话输入框模型同步 E2E：进入 IM 会话后，底部输入框的模型选择器应显示
// 机器人对话实际使用的模型（channel.model），而非全局默认/上一个会话遗留的模型。
// 同时守护「用户手动改过的模型不被程序化同步覆盖」契约：切走再切回仍为用户所选。
// 机器人 model=null 回退智能体模型的解析分支由单元测试覆盖（util/channel-model.test.ts）。
import { expect, test } from "@playwright/test";
import { E2E_WS_PORT } from "../playwright.config";
import { saveProvider, setUiPrefs, selectModel } from "./helpers";

const KERNEL = `http://127.0.0.1:${E2E_WS_PORT}`;

test.describe("IM 会话输入框模型同步机器人模型", () => {
	let channelId: string | null = null;

	test.afterEach(async ({ request }) => {
		if (channelId)
			await request
				.delete(`${KERNEL}/api/channels/${channelId}`)
				.catch(() => {});
		channelId = null;
	});

	test("进入 IM 会话显示机器人模型；手动改模型后重进保留用户选择", async ({
		page,
		request,
	}) => {
		test.setTimeout(120_000);
		// 预置 provider（两个模型：model-a 机器人用 / model-b 用户手改目标）
		await saveProvider({
			id: "e2e-immodel-provider",
			name: "E2E ImModel",
			slug: "e2e-immodel",
			baseUrl: "http://localhost:9999/v1",
			apiKey: "sk-e2e",
			api: "openai-completions",
			models: [
				{ id: "model-a", contextWindow: 128000, maxTokens: 4096 },
				{ id: "model-b", contextWindow: 128000, maxTokens: 4096 },
			],
		});
		// mock 渠道绑定 model-a（机器人实际用模）
		const res = await request.post(`${KERNEL}/api/channels`, {
			data: {
				channel: {
					type: "mock",
					name: "E2E-ImModel",
					enabled: true,
					credentials: { botId: "mock-im", secret: "mock-s" },
					agentName: "dev",
					model: "e2e-immodel/model-a",
					extraSystemPrompt: "",
					replyGranularity: "standard",
				},
			},
		});
		expect(res.ok()).toBeTruthy();
		channelId = ((await res.json()) as any).channels[0].id;
		// 进站消息 → kernel 侧产生 IM 会话
		await request.post(`${KERNEL}/api/channels/${channelId}/mock-inbound`, {
			data: { chatId: "u-immodel", text: "你好" },
		});
		// 等会话进入 IM 列表
		let sessionId = "";
		await expect(async () => {
			const r = await request.get(`${KERNEL}/api/channel-conversations`);
			const body = (await r.json()) as any;
			const conv = (body.conversations ?? []).find(
				(c: any) => c.channelId === channelId,
			);
			expect(conv).toBeTruthy();
			sessionId = conv.sessionId;
		}).toPass({ timeout: 15_000 });
		expect(sessionId).toBeTruthy();

		// 打开前端 → IM 页签 → 点击该会话
		// 预置 ui-prefs：跳过主题引导弹窗（否则 modal-overlay 挡住所有点击）+ 中文界面
		await setUiPrefs(page, "zh");
		await page.goto("/");
		await page.getByTestId("sidebar-tab-im").click();
		await expect(page.getByTestId("im-conv-list")).toBeVisible({
			timeout: 5000,
		});
		await page
			.locator('button[data-testid^="im-conv-"]', { hasText: "u-immodel" })
			.click();
		await expect(page.getByTestId("session-view")).toBeVisible({
			timeout: 5000,
		});

		// 核心断言：模型选择器 = 机器人配置的模型（而非全局默认或空）
		await expect(page.getByTestId("main-selector")).toHaveAttribute("data-value", 
			"e2e-immodel/model-a",
			{ timeout: 8000 },
		);

		// 用户手动切到 model-b → 切走（任务页签）→ 再回来 → 仍为 model-b（显式选择不被覆盖）
		await selectModel(page, "e2e-immodel/model-b");
		await page.getByTestId("sidebar-tab-tasks").click();
		await page.getByTestId("sidebar-tab-im").click();
		await page
			.locator('button[data-testid^="im-conv-"]', { hasText: "u-immodel" })
			.click();
		await expect(page.getByTestId("session-view")).toBeVisible({
			timeout: 5000,
		});
		await expect(page.getByTestId("main-selector")).toHaveAttribute("data-value", 
			"e2e-immodel/model-b",
			{ timeout: 8000 },
		);
	});
});
