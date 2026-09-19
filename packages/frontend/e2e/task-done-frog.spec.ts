import { expect, test } from "@playwright/test";

// 任务完成青蛙动画 E2E：外观 tab 的「任务完成动画」开关可切换并持久化。
// （青蛙「跳出动画」的浏览器渲染已由组件测试 + POC 浏览器实测覆盖；本用例验证真实应用内开关链路。）
test("设置-外观：任务完成动画开关可切换并持久化", async ({ page }) => {
	await page.goto("/");
	// 首次冷启动可能弹出引导/未配置模型 modal，先按 Escape 关闭再操作设置
	await page.keyboard.press("Escape");
	await page.getByTestId("settings-btn").click();
	await expect(page.getByTestId("settings-modal")).toBeVisible();

	// 切到外观 tab
	await page.getByTestId("settings-nav-appearance").click();
	const toggle = page.getByTestId("frog-task-done-toggle");
	await expect(toggle).toBeVisible();
	await expect(toggle).toHaveAttribute("data-on", "true");

	await toggle.click();
	await expect(toggle).toHaveAttribute("data-on", "false");
	const persisted = await page.evaluate(() => {
		const raw = localStorage.getItem("wa-pi-ui-prefs");
		return raw ? JSON.parse(raw).state : null;
	});
	expect(persisted?.frogTaskDone).toBe(false);

	// 刷新后保持关闭
	await page.reload();
	await page.getByTestId("settings-btn").click();
	await page.getByTestId("settings-nav-appearance").click();
	await expect(page.getByTestId("frog-task-done-toggle")).toHaveAttribute(
		"data-on",
		"false",
	);
});
