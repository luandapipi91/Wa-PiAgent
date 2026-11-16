// 主题引导 E2E（第四层）：老用户升级后弹一次、选完落库、关闭回滚。
import { test, expect } from "@playwright/test";
import { ensureProvider, setUiPrefs } from "./helpers";

// 无 provider 时首启会弹 onboarding 向导，其 modal-overlay 会拦截点击
test.beforeAll(async () => {
	await ensureProvider();
});

test("老用户升级弹主题引导，选赛博后关闭且刷新不再弹", async ({ page }) => {
	// 不写 themeIntroSeenVersion，模拟老数据（升级前没有这个字段）
	await setUiPrefs(page, "zh", { themeMode: "light", themeIntroSeenVersion: null });
	await page.goto("/");
	await expect(page.getByTestId("theme-intro")).toBeVisible({ timeout: 10_000 });

	await page.getByTestId("theme-card-cyber").click();
	await page.getByTestId("theme-confirm").click();
	await expect(page.locator("html")).toHaveAttribute("data-theme", "cyber");
	await expect(page.getByTestId("theme-intro")).toHaveCount(0);

	// 已读记录已写盘，刷新不再弹
	const seen = await page.evaluate(() => {
		const raw = localStorage.getItem("wa-pi-ui-prefs");
		return raw ? JSON.parse(raw).state?.themeIntroSeenVersion : undefined;
	});
	expect(seen).toBeTruthy();
	await page.reload();
	await expect(page.getByTestId("theme-intro")).toHaveCount(0);
});

test("升级引导被关闭时回滚到原主题", async ({ page }) => {
	await setUiPrefs(page, "zh", { themeMode: "light", themeIntroSeenVersion: null });
	await page.goto("/");
	await expect(page.getByTestId("theme-intro")).toBeVisible({ timeout: 10_000 });
	await page.getByTestId("theme-card-pixel").click();
	await expect(page.locator("html")).toHaveAttribute("data-theme", "pixel");
	await page.getByTestId("theme-intro-close").click();
	await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});
