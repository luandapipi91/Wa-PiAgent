import { expect, test } from "@playwright/test";

// 提示音设置 UI E2E：声音本身无法在自动化中断言，只验证设置项存在、
// 开关可切换并持久化到 localStorage（wa-pi-ui-prefs）。
test("设置-通用：提示音开关可切换并持久化", async ({ page }) => {
	await page.goto("/");
	await page.getByTestId("settings-btn").click();
	await expect(page.getByTestId("settings-modal")).toBeVisible();
	// 通用是默认 tab，两个开关应直接可见
	const taskDone = page.getByTestId("sound-task-done-toggle");
	const needsAction = page.getByTestId("sound-needs-action-toggle");
	await expect(taskDone).toBeVisible();
	await expect(needsAction).toBeVisible();
	await expect(taskDone).toHaveAttribute("data-on", "true");
	await expect(needsAction).toHaveAttribute("data-on", "true");

	// 关闭任务完成提示音 → 持久化到 localStorage
	await taskDone.click();
	await expect(taskDone).toHaveAttribute("data-on", "false");
	const persisted = await page.evaluate(() => {
		const raw = localStorage.getItem("wa-pi-ui-prefs");
		return raw ? JSON.parse(raw).state : null;
	});
	expect(persisted?.soundTaskDone).toBe(false);
	expect(persisted?.soundNeedsAction).toBe(true);

	// 刷新后保持
	await page.reload();
	await page.getByTestId("settings-btn").click();
	await expect(page.getByTestId("sound-task-done-toggle")).toHaveAttribute(
		"data-on",
		"false",
	);
});
