import { expect, test } from "@playwright/test";
import { saveProvider } from "./helpers";

// 提示音设置 UI E2E：声音本身无法在自动化中断言，只验证设置项存在、
// 开关可切换并持久化到 localStorage（wa-pi-ui-prefs）。
test("设置-通用：提示音开关可切换并持久化", async ({ page }) => {
	await page.goto("/");
	// 预置假 provider：全新隔离目录无 provider 时首启 onboarding 向导会弹出、
	// 其 modal-overlay 会拦截设置弹窗内的点击（file-change-summary.spec 同坑）
	await saveProvider({
		id: "sound-e2e-provider",
		name: "Sound E2E",
		baseUrl: "https://example.invalid",
		apiKey: "sk-test",
		api: "openai-completions",
		models: [{ id: "test-model", contextWindow: 100000, maxTokens: 8192 }],
	});
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

// 定时任务完成提示音：默认关（需求：默认没有青蛙叫）；可开、可持久化
test("设置-通用：定时任务完成提示音开关默认关、可切换并持久化", async ({
	page,
}) => {
	await page.goto("/");
	// 同上：预置假 provider 规避 onboarding 向导拦截
	await saveProvider({
		id: "sound-e2e-provider-2",
		name: "Sound E2E 2",
		baseUrl: "https://example.invalid",
		apiKey: "sk-test",
		api: "openai-completions",
		models: [{ id: "test-model", contextWindow: 100000, maxTokens: 8192 }],
	});
	await page.getByTestId("settings-btn").click();
	await expect(page.getByTestId("settings-modal")).toBeVisible();
	const schedToggle = page.getByTestId("sound-sched-task-done-toggle");
	await expect(schedToggle).toBeVisible();
	// 默认关
	await expect(schedToggle).toHaveAttribute("data-on", "false");

	// 开启 → 持久化到 localStorage
	await schedToggle.click();
	await expect(schedToggle).toHaveAttribute("data-on", "true");
	const persisted = await page.evaluate(() => {
		const raw = localStorage.getItem("wa-pi-ui-prefs");
		return raw ? JSON.parse(raw).state : null;
	});
	expect(persisted?.soundSchedTaskDone).toBe(true);

	// 刷新后保持
	await page.reload();
	await page.getByTestId("settings-btn").click();
	await expect(page.getByTestId("sound-sched-task-done-toggle")).toHaveAttribute(
		"data-on",
		"true",
	);
});
