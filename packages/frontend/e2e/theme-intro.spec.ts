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

test("点卡片即生效：关闭弹窗与刷新后都保留所选主题", async ({ page }) => {
	// 不预置 ui-prefs（addInitScript 每次导航都会重写，会干扰「刷新后是否保留」的断言）：
	// 有 provider 且无已读记录 → 直接走老用户升级路径
	await page.goto("/");
	await expect(page.getByTestId("theme-intro")).toBeVisible({ timeout: 10_000 });

	await page.getByTestId("theme-card-pixel").click();
	await expect(page.locator("html")).toHaveAttribute("data-theme", "pixel");

	// 不点「完成」直接关闭：选择仍保留（即时生效，无预览态）
	await page.getByTestId("theme-intro-close").click();
	await expect(page.locator("html")).toHaveAttribute("data-theme", "pixel");

	// 刷新也还在（已写进 localStorage）
	await page.reload();
	await page.waitForTimeout(500);
	await expect(page.locator("html")).toHaveAttribute("data-theme", "pixel");
});
