import { expect, test } from "@playwright/test";

const KERNEL = `http://127.0.0.1:${process.env.WA_PI_E2E_WS_PORT ?? 9776}`;

test.describe.serial("企微机器人：默认工作目录 + 切换开关", () => {
	// 用唯一的名称/凭据定位本用例创建的渠道（见删除处的教训注释）
	const botName = "e2e-default-workdir-bot";
	const botId = "ww-e2e-workdir-fake";
	let channelId: string;

	test("配置默认工作目录与允许切换开关，保存后回填校验", async ({ page, request }) => {
		await page.goto("/");
		await page.getByTestId("settings-btn").click();
		await page.getByTestId("settings-nav-bots").click();

		// 新建企微机器人（假凭据）
		await page.getByTestId("bots-new-btn").click();
		await page.getByTestId("channel-chip-wecom").click();
		await page.getByTestId("bot-name-input").fill(botName);
		await page.getByTestId("bot-botid-input").fill(botId);
		await page.getByTestId("bot-secret-input").fill("fake-secret");

		// 默认工作目录下拉：可见，默认值为 __system__（默认工作区）
		const select = page.getByTestId("bot-default-project-select");
		await expect(select).toBeVisible();
		await expect(select).toHaveValue("__system__");
		// 选项含「默认工作区」和预置的「E2E项目」（projects 异步加载，自动重试等待）
		await expect(select.locator('option[value="e2e-proj-1"]')).toHaveText("E2E项目");
		await expect(select.locator('option[value="__system__"]')).toHaveText("默认工作区");

		// 选择「E2E项目」并勾选允许切换
		await select.selectOption("e2e-proj-1");
		await page.getByTestId("bot-allow-switch-toggle").check();
		await page.getByTestId("bot-save-btn").click();

		// 列表中出现该机器人（假凭据连接不上：卡片出现即可）
		const card = page.locator('[data-testid^="bot-card-"]', { hasText: botName });
		await expect(card).toBeVisible({ timeout: 5000 });

		// 重新打开编辑表单：下拉回显 e2e-proj-1、开关已勾选（保存 → 回填链路）
		await card.click();
		await expect(page.getByTestId("bot-default-project-select")).toHaveValue("e2e-proj-1");
		await expect(page.getByTestId("bot-allow-switch-toggle")).toBeChecked();

		// 立即删除该 wecom 渠道：假凭据会令 WecomAdapter 反复重连企微 WS，
		// 其重连噪音会阻塞后续 mock 渠道的进站处理（事件循环拥塞）。
		// 注意：必须按「本用例创建的渠道 id」删除——曾有按 type 查找误删用户真实渠道的事故。
		const list = await request.get(`${KERNEL}/api/channels`);
		const channels = ((await list.json()) as any).channels as any[];
		const created = channels.find(
			(c) => c.name === botName && c.credentials?.botId === botId,
		);
		if (created) {
			channelId = created.id;
			await request.delete(`${KERNEL}/api/channels/${created.id}`);
		}
	});

	test.afterAll(async ({ request }) => {
		// 兜底：再按名称删一次（防止用例中断导致上面的删除没跑到）
		if (channelId) {
			await request.delete(`${KERNEL}/api/channels/${channelId}`);
		} else {
			const list = await request.get(`${KERNEL}/api/channels`);
			const channels = ((await list.json()) as any).channels as any[];
			for (const c of channels) {
				if (c.name === botName && c.credentials?.botId === botId) {
					await request.delete(`${KERNEL}/api/channels/${c.id}`);
				}
			}
		}
	});
});
