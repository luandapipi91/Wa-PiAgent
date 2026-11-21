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


// 任务完成青蛙动画 E2E：外观 tab 的「任务完成动画」开关可切换并持久化。
// （青蛙「跳出动画」的浏览器渲染已由组件测试 + POC 浏览器实测覆盖；本用例验证真实应用内开关链路。）
test("设置-外观：任务完成动画开关可切换并持久化", async ({ page }) => {
	// seed + 预置 ui-prefs 须在首个 goto 之前（否则向导/主题引导弹窗挡点击）
	await saveProvider({
		id: "e2e-task-done-frog-provider",
		name: "E2E Frog",
		slug: "e2e-task-done-frog",
		baseUrl: "http://localhost:9999/v1",
		apiKey: "sk-e2e",
		api: "openai-completions",
		models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
	});
	await seedUiPrefsOnce(page, "zh");
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
