// 新会话发送后「会话新建中」加载页 E2E（第四层）：
// 发送 prompt 到收到服务器回调（echo_user / agent_start）之间，MessageList 显示
// 「会话新建中」加载页，不白屏；回调到达后加载页消失。
// 用 page.route 延迟 prompt 请求，制造可控的回调窗口，稳定断言出现→消失。
import { test, expect } from "@playwright/test";
import { saveProvider } from "./helpers";

test("新会话发送后显示「会话新建中」加载页，回调到达后消失", async ({
	page,
}) => {
	test.setTimeout(60_000);
	// 预置假 provider：避免首次启动向导弹窗遮挡 + 满足发送前置条件 isModelAvailable
	await saveProvider({
		id: "e2e-init-provider",
		name: "E2E Init",
		slug: "e2e-init",
		baseUrl: "http://localhost:9999/v1",
		apiKey: "sk-e2e",
		api: "openai-completions",
		models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
	});

	// 拦截 prompt 请求：延迟 3s 放行，制造「已发送、未收到回调」的窗口
	let promptDelayed = false;
	await page.route("**/api/agents/**/prompt", async (route) => {
		if (!promptDelayed) {
			promptDelayed = true;
			await new Promise((r) => setTimeout(r, 3_000));
		}
		await route.continue();
	});

	await page.goto("/");
	const pane = page.getByTestId("new-session-pane");
	await expect(pane).toBeVisible({ timeout: 10_000 });

	// 发送新会话消息
	await page.getByRole("textbox").fill("加载页 E2E 测试");
	await page.getByTestId("composer-send").click();
	await expect(page.getByTestId("session-view")).toBeVisible({
		timeout: 10_000,
	});

	// 窗口期（prompt 被延迟）：加载页出现，不白屏
	const initializing = page.getByTestId(/session-initializing-/);
	await expect(initializing).toBeVisible({ timeout: 5_000 });

	// 互斥：窗口内只显示「会话新建中」，不叠加「加载会话」（避免两个 spinner 重叠）
	await expect(page.getByTestId(/history-loading-/)).toHaveCount(0);

	// 回调到达（echo_user → 用户消息出现）后：加载页消失
	await expect(
		page
			.locator('[data-testid^="msg-"]')
			.filter({ hasText: "加载页 E2E 测试" })
			.first(),
	).toBeVisible({ timeout: 15_000 });
	await expect(initializing).toHaveCount(0);
});
