// 前端渲染层真实验证（方案 A）：注入 compaction_start / compaction_end（成功负载）事件，
// 断言压缩成功提示出现在消息流末尾、且仅一条（不在会话顶部重复）。
// 走真实前端渲染链路（__PI_E2E_EVENT__ → onMessage → sdk:event → handleSDKEvent）。
import { test, expect } from "@playwright/test";
import { saveProvider } from "./helpers";

test("压缩成功注入：提示出现在消息流末尾且仅一条", async ({ page }) => {
	test.setTimeout(90_000);
	await saveProvider({
		id: "e2e-compact-provider",
		name: "E2E Compact",
		slug: "e2e-compact",
		baseUrl: "http://localhost:9999/v1",
		apiKey: "sk-e2e",
		api: "openai-completions",
		models: [
			{
				id: "model-compact",
				contextWindow: 128000,
				maxTokens: 4096,
			},
		],
	});

	await page.goto("/");
	const pane = page.getByTestId("new-session-pane");
	await expect(pane).toBeVisible({ timeout: 10_000 });

	// 发消息建会话并选中（乐观回显产生 user 消息 → MessageList 出现带 sessionId 的 msg）
	await page.getByRole("textbox").fill("压缩成功提示 E2E 测试");
	await page.getByTestId("composer-send").click();
	await expect(page.getByTestId("session-view")).toBeVisible({
		timeout: 12_000,
	});

	// 从 MessageList 第一条 msg 的 data-testid 解析当前会话 id（msg-<sessionId>-<ts>）
	const sessionId = await page
		.locator("[data-testid^='msg-']")
		.first()
		.getAttribute("data-testid")
		.then((v) => v!.replace(/^msg-/, "").replace(/-\d+$/, ""));
	if (!sessionId) throw new Error("未能解析当前会话 id");

	// 注入 compaction_start：插入「正在压缩上下文…」居中消息
	await page.evaluate((sid) => {
		const emit = (window as any).__PI_E2E_EVENT__;
		if (!emit) throw new Error("__PI_E2E_EVENT__ 未挂载（非 dev 环境？）");
		emit({
			type: "sdk:event",
			sessionId: sid,
			event: { type: "compaction_start", reason: "manual" },
		});
	}, sessionId);
	await page.waitForTimeout(500);

	// 注入 compaction_end 成功负载
	await page.evaluate((sid) => {
		const emit = (window as any).__PI_E2E_EVENT__;
		if (!emit) throw new Error("__PI_E2E_EVENT__ 未挂载（非 dev 环境？）");
		emit({
			type: "sdk:event",
			sessionId: sid,
			event: {
				type: "compaction_end",
				reason: "manual",
				result: {
					summary: "摘要",
					firstKeptEntryId: "abc",
					tokensBefore: 1000,
					estimatedTokensAfter: 300,
				},
				aborted: false,
				willRetry: false,
			},
		});
	}, sessionId);
	await page.waitForTimeout(600);

	// 断言消息流末尾出现「已压缩早期上下文」提示（方案 A：压缩成功提示在末尾，不在顶部）
	const compactHints = page.locator("text=/已压缩早期上下文/");
	await expect(compactHints.first()).toBeVisible({ timeout: 8_000 });
	// 会话里只有一条压缩提示（末尾那条），顶部不得重复出现
	await expect(compactHints).toHaveCount(1);
});
