import { expect, test } from "@playwright/test";
import { saveProvider } from "./helpers";

/** 预置 ui-prefs（仅首次写入）：挡主题引导，但不覆盖 reload 后的持久化值。
 *  helpers.setUiPrefs 每次导航都重写 prefs，会冲掉本 spec 断言的「切换并持久化」状态。 */
async function seedUiPrefsOnce(page: import("@playwright/test").Page, lang: "zh" | "en") {
	await page.addInitScript((lang) => {
		if (!localStorage.getItem("wa-pi-ui-prefs")) {
			localStorage.setItem(
				"wa-pi-ui-prefs",
				JSON.stringify({
					state: {
						language: lang,
						fontSize: 16,
						exportTurns: 1,
						themeIntroSeenVersion: "e2e-seen",
					},
					version: 0,
				}),
			);
		}
	}, lang);
}


// 提示音设置 UI E2E：声音本身无法在自动化中断言，只验证设置项存在、
// 开关可切换并持久化到 localStorage（wa-pi-ui-prefs）。
test("设置-通用：提示音开关可切换并持久化", async ({ page }) => {
	// seed + 预置 ui-prefs 须在首个 goto 之前（否则向导/主题引导弹窗挡点击）
	await saveProvider({
		id: "sound-e2e-provider",
		name: "Sound E2E",
		baseUrl: "https://example.invalid",
		apiKey: "sk-test",
		api: "openai-completions",
		models: [{ id: "test-model", contextWindow: 100000, maxTokens: 8192 }],
	});
	await seedUiPrefsOnce(page, "zh");
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

// 定时任务完成提示音：默认关（需求：默认没有青蛙叫）；可开、可持久化
test("设置-通用：定时任务完成提示音开关默认关、可切换并持久化", async ({
	page,
}) => {
	// 同上：seed + 预置 ui-prefs 须在首个 goto 之前
	await saveProvider({
		id: "sound-e2e-provider-2",
		name: "Sound E2E 2",
		baseUrl: "https://example.invalid",
		apiKey: "sk-test",
		api: "openai-completions",
		models: [{ id: "test-model", contextWindow: 100000, maxTokens: 8192 }],
	});
	await seedUiPrefsOnce(page, "zh");
	await page.goto("/");
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
