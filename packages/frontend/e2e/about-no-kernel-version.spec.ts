import { test, expect } from "@playwright/test";
import { createProject, ensureProvider } from "./helpers";

/**
 * 关于页不再展示「内核版本」E2E。
 *
 * 背景：内核独立打包/独立升级机制已移除，内核随安装包发布，
 * 关于页只保留应用版本（内核版本行、i18n 文案、store 字段同步删除）。
 *
 * 截图清理：本 spec 不落截图，无需清理。
 */
test.describe("关于页：内核版本行已移除", () => {
  // 防无 provider 首启 onboarding 向导遮挡点击
  test.beforeAll(async () => {
    await ensureProvider();
  });

  test("关于分区显示应用版本，且不再出现内核版本文案", async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem(
        "wa-pi-ui-prefs",
        JSON.stringify({
          state: { language: "zh", fontSize: 16, exportTurns: 1 },
          version: 0,
        }),
      );
    });
    await createProject("e2e-about", "/tmp/e2e-about");
    await page.goto("/");
    await page.getByTestId("settings-btn").click();
    await expect(page.getByTestId("settings-modal")).toBeVisible({
      timeout: 5000,
    });

    await page.getByTestId("settings-nav-about").click();
    await expect(page.getByTestId("about-section")).toBeVisible();

    // 应用版本行仍在
    await expect(page.getByText(/版本 \d+\.\d+\.\d+/)).toBeVisible();
    // 内核版本行（中英文）均已移除
    await expect(page.locator("text=内核版本")).toHaveCount(0);
    await expect(page.locator("text=Kernel")).toHaveCount(0);
  });
});
