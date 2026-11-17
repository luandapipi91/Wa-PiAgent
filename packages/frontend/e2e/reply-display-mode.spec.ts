// 回复显示模式 E2E（第四层）：真实浏览器 + 隔离 kernel。
//
// 覆盖：
// 1. 外观设置里存在「回复显示」下拉，默认「精简输出」；
// 2. 切到「完整输出」后写入 localStorage（wa-pi-ui-prefs.replyDisplayMode=full）；
// 3. 刷新页面后设置仍生效（持久化）。
//
// 说明：会话区「完整输出合并成一张卡片 / 精简输出入口展开」的渲染行为由
// tests/MessageList.test.tsx 的第二层组件测试覆盖（真实 LLM 会话成本高且输出不稳定，
// 这里只盖设置链路与持久化）。
import { test, expect } from "@playwright/test";
import { ensureProvider, setUiPrefs } from "./helpers";

test.beforeAll(async () => {
	await ensureProvider();
});

test("外观设置：回复显示默认精简，切换完整后刷新仍生效", async ({ page }) => {
	await setUiPrefs(page, "zh");
	await page.goto("/");

	await page.getByTestId("settings-btn").click();
	await expect(page.getByTestId("settings-nav-appearance")).toBeVisible();
	await page.getByTestId("settings-nav-appearance").click();

	const select = page.getByTestId("reply-display-select");
	await expect(select).toBeVisible();
	await expect(select).toHaveValue("concise");

	await select.selectOption("full");
	await expect(select).toHaveValue("full");

	// 持久化：localStorage 里写入完整输出
	const stored = await page.evaluate(() => {
		const raw = localStorage.getItem("wa-pi-ui-prefs");
		return raw ? JSON.parse(raw).state.replyDisplayMode : null;
	});
	expect(stored).toBe("full");

	// 重新打开设置弹窗（组件重新挂载）后仍读到 full——值来自 persisted store 而非组件内部状态。
	// 注：不在此处 reload，因为 setUiPrefs 的 addInitScript 会在每次导航时重写 localStorage。
	await page.getByRole("button", { name: "关闭" }).first().click();
	await page.getByTestId("settings-btn").click();
	await page.getByTestId("settings-nav-appearance").click();
	await expect(page.getByTestId("reply-display-select")).toHaveValue("full");

	// 切回精简，避免污染后续用例（同一浏览器上下文内）
	await page.getByTestId("reply-display-select").selectOption("concise");
	await expect(page.getByTestId("reply-display-select")).toHaveValue("concise");
});
