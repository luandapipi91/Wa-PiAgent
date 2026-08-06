import { expect, test } from "@playwright/test";

const KERNEL = `http://127.0.0.1:${process.env.WA_PI_E2E_WS_PORT ?? 9776}`;

/** 轮询直到 fn 返回真值，超时抛错（仿 helpers.ts 的 pollUntil，但该函数未导出） */
async function pollUntil<T>(
	fn: () => Promise<T | undefined | null | false>,
	timeoutMs = 10_000,
	intervalMs = 200,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > deadline) throw new Error("pollUntil 超时");
		await new Promise((r) => setTimeout(r, intervalMs));
	}
}

test.describe.serial("IM 渠道机器人", () => {
	let channelId: string;

	test("设置页创建机器人（企微表单，假凭据）", async ({ page, request }) => {
		await page.goto("/");
		await page.getByTestId("settings-btn").click();
		await page.getByTestId("settings-nav-bots").click();
		await page.getByTestId("bots-new-btn").click();
		// 置灰项不可点
		await expect(page.getByTestId("channel-chip-feishu")).toHaveAttribute(
			"data-disabled",
			"true",
		);
		await page.getByTestId("channel-chip-wecom").click();
		await page.getByTestId("bot-name-input").fill("E2E机器人");
		await page.getByTestId("bot-botid-input").fill("ww-e2e-fake");
		await page.getByTestId("bot-secret-input").fill("fake-secret");
		await page.getByTestId("bot-save-btn").click();
		// 假凭据连接不上：卡片出现即可
		await expect(page.getByText("E2E机器人")).toBeVisible({ timeout: 5000 });
		// 立即删除该 wecom 渠道：假凭据会令 WecomAdapter 反复重连企微 WS，
		// 其重连噪音会阻塞后续 mock 渠道的进站处理（事件循环拥塞）。
		const list = await request.get(`${KERNEL}/api/channels`);
		const channels = ((await list.json()) as any).channels as any[];
		const wecom = channels.find((c) => c.type === "wecom");
		if (wecom) await request.delete(`${KERNEL}/api/channels/${wecom.id}`);
	});

	test("mock 渠道消息全链路：进站 → 回复 → 侧边栏 IM 页签 → 打开会话", async ({
		page,
	}) => {
		// REST 建 mock 渠道（enabled，model 跟随智能体；E2E 环境无真实 provider，
		// 回复为错误提示也算链路通）
		const res = await page.request.post(`${KERNEL}/api/channels`, {
			data: {
				channel: {
					type: "mock",
					name: "E2E-Mock",
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

		// 注入进站消息
		await page.request.post(`${KERNEL}/api/channels/${channelId}/mock-inbound`, {
			data: { chatId: "u-e2e", text: "你好" },
		});
		// outbox 出现回复（无真实模型 → 错误提示回复，链路通即可）
		await pollUntil(async () => {
			const r = await page.request.get(
				`${KERNEL}/api/channels/${channelId}/mock-outbox`,
			);
			const body = (await r.json()) as any;
			return body.messages?.length > 0 ? body : null;
		});

		// 侧边栏 IM 页签出现会话，点击打开
		await page.goto("/");
		await page.getByTestId("sidebar-tab-im").click();
		await expect(page.getByTestId("im-conv-list")).toBeVisible({ timeout: 5000 });
		await page.getByText("u-e2e").click();
		await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 5000 });
		await expect(page.getByTestId("im-source-badge")).toBeVisible();
		await expect(page.getByText("仅显示最近 100 条")).toBeVisible();
	});

	test.afterAll(async ({ request }) => {
		if (channelId) await request.delete(`${KERNEL}/api/channels/${channelId}`);
	});
});
