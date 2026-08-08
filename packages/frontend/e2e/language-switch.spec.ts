import { test, expect } from "@playwright/test";
import { createProject } from "./helpers";

/**
 * 系统设置-通用「语言」切换 E2E。
 *
 * Playwright 每个 test 用独立 page（独立浏览器上下文 / localStorage），
 * 故每个用例用 addInitScript 显式预置 localStorage 来锁定起始语言状态，
 * 不依赖 serial 间的状态延续。
 *
 * 覆盖：
 * - 默认中文：通用分区文案为中文
 * - 切换到英文：导航 + 通用分区文案变英文
 * - 英文持久化后刷新仍为英文（localStorage → detect 分支）
 * - 切回中文：文案恢复中文
 *
 * 截图清理：本 spec 不落截图，无需清理。
 */

/** 预置 ui-prefs localStorage（language/字体/导出轮数）。 */
async function setUiPrefs(page: import("@playwright/test").Page, language: "zh" | "en") {
  await page.addInitScript((lang) => {
    localStorage.setItem(
      "wa-pi-ui-prefs",
      JSON.stringify({ state: { language: lang, fontSize: 16, exportTurns: 1 }, version: 0 }),
    );
  }, language);
}

test.describe("系统设置-通用 语言切换", () => {

  test("默认中文：设置弹窗标题与通用分区文案为中文", async ({ page }) => {
    await setUiPrefs(page, "zh");
    await createProject("e2e-lang", "/tmp/e2e-lang");
    await page.goto("/");
    await page.getByTestId("settings-btn").click();
    await expect(page.getByTestId("settings-modal")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("系统设置").first()).toBeVisible();
    await expect(page.getByText("文字大小").first()).toBeVisible();
  });

  test("切换到英文：导航与通用分区文案变英文", async ({ page }) => {
    await setUiPrefs(page, "zh");
    await createProject("e2e-lang", "/tmp/e2e-lang");
    await page.goto("/");
    await page.getByTestId("settings-btn").click();
    await expect(page.getByTestId("settings-modal")).toBeVisible({ timeout: 5000 });

    // 语言为草稿态：select 改英文后需点保存才生效
    await page.getByTestId("language-select").selectOption("en");
    await page.getByTestId("retry-save-btn").click();

    await expect(page.getByText("Settings").first()).toBeVisible();
    await expect(page.getByTestId("settings-nav-general")).toHaveText("General");
    await expect(page.getByText("Auto retry").first()).toBeVisible();
    await expect(page.getByText("文字大小")).toHaveCount(0);
  });

  test("英文下切到供应商分区：分区文案为英文", async ({ page }) => {
    await setUiPrefs(page, "en");
    await createProject("e2e-lang", "/tmp/e2e-lang");
    await page.goto("/");
    await page.getByTestId("settings-btn").click();
    await expect(page.getByTestId("settings-modal")).toBeVisible({ timeout: 5000 });

    // 切到 Models 分区（英文下导航文案为 "Models"），断言「+ Add provider」按钮为英文
    await page.getByText("Models", { exact: true }).click();
    await expect(page.getByTestId("add-provider-btn")).toHaveText("+ Add provider");
  });

  test("英文持久化后刷新仍为英文", async ({ page }) => {
    // 预置英文 localStorage，模拟「上一次切到英文后重新打开应用」
    await setUiPrefs(page, "en");
    await createProject("e2e-lang", "/tmp/e2e-lang");
    await page.goto("/");
    await page.getByTestId("settings-btn").click();
    await expect(page.getByTestId("settings-modal")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Settings").first()).toBeVisible();
    await expect(page.getByTestId("language-select")).toHaveValue("en");
  });

  test("切回中文：文案恢复中文", async ({ page }) => {
    // 起始为英文，验证切回中文
    await setUiPrefs(page, "en");
    await createProject("e2e-lang", "/tmp/e2e-lang");
    await page.goto("/");
    await page.getByTestId("settings-btn").click();
    await expect(page.getByTestId("settings-modal")).toBeVisible({ timeout: 5000 });
    // 起始英文
    await expect(page.getByText("Settings").first()).toBeVisible();

    // 语言为草稿态：select 改中文后需点保存才生效
    await page.getByTestId("language-select").selectOption("zh");
    await page.getByTestId("retry-save-btn").click();
    await expect(page.getByText("系统设置").first()).toBeVisible();
    await expect(page.getByTestId("settings-nav-general")).toHaveText("通用");
    await expect(page.getByText("文字大小").first()).toBeVisible();
  });
});
