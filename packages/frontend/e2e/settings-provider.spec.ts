import { test, expect } from "@playwright/test";
import { createProject } from "./helpers";

test.describe.serial("设置页供应商管理", () => {

  test("打开设置页", async ({ page }) => {
    await page.goto("/");
    // 先建项目让 sidebar 显示（复用 app-flow 的模式）
    await createProject("e2e-settings", "/tmp/e2e-settings");

    await page.goto("/");
    await expect(page.getByTestId("settings-btn")).toBeVisible({ timeout: 5000 });
    await page.getByTestId("settings-btn").click();
    await expect(page.getByTestId("settings-modal")).toBeVisible();
    await expect(page.getByText("模型管理")).toBeVisible();
  });

  test("添加供应商完整流程", async ({ page }) => {
    await page.goto("/");
    // 确保有项目（serial 共享 kernel，可能上一步已建）
    await createProject("e2e-settings", "/tmp/e2e-settings");

    await page.goto("/");
    await page.getByTestId("settings-btn").click();
    await page.getByTestId("add-provider-btn").click();

    // 填表单
    await page.getByTestId("field-name").fill("E2E Test Provider");
    await page.getByTestId("field-baseUrl").fill("https://api.e2e-test.com/v1");
    await page.getByTestId("field-apiKey").fill("sk-e2e-test");
    // tag 录入模型 id
    await page.getByTestId("tag-input-field").fill("e2e-model-1|");
    await expect(page.locator('[data-testid="tag-input"]').getByText("e2e-model-1")).toBeVisible();

    // 保存
    await page.getByTestId("provider-save-btn").click();
    // 等待 form modal 关闭
    await expect(page.getByTestId("provider-form-modal")).not.toBeVisible({ timeout: 3000 });
    // 卡片出现（不断言总数：全套 spec 共享 kernel，其他 spec 预置的 provider 卡片同在列表）
    const card = page.locator('[data-testid^="provider-card-"]', { hasText: "E2E Test Provider" });
    await expect(card).toBeVisible({ timeout: 5000 });
    await expect(card.getByText("e2e-model-1")).toBeVisible();
  });

  test("删除供应商流程", async ({ page }) => {
    await page.goto("/");
    await createProject("e2e-settings", "/tmp/e2e-settings");

    await page.goto("/");
    await page.getByTestId("settings-btn").click();

    // 删除上一步添加的那张卡片（按名称作用域，避免误删其他 spec 预置的 provider）
    const card = page.locator('[data-testid^="provider-card-"]', { hasText: "E2E Test Provider" });
    await expect(card).toBeVisible({ timeout: 5000 });
    await card.locator('[data-testid^="provider-delete-"]').click();

    // ConfirmDialog
    await expect(page.getByTestId("confirm-dialog")).toBeVisible();
    await page.getByTestId("confirm-ok").click();

    // 该卡片消失
    await expect(card).toHaveCount(0, { timeout: 5000 });
  });

  test("快捷选择预设填充表单并保存", async ({ page }) => {
    await page.goto("/");
    await createProject("e2e-settings", "/tmp/e2e-settings");

    await page.goto("/");
    await page.getByTestId("settings-btn").click();
    await page.getByTestId("add-provider-btn").click();

    // 等待 SDK 预设列表加载完成（下拉中至少出现一个预设选项）
    await expect(page.locator('[data-testid="preset-select"] option:not([value=""])').first()).toBeVisible({ timeout: 10000 });

    // 选 DeepSeek 预设 → 字段被自动填入
    await page.getByTestId("preset-select").selectOption("deepseek");
    await expect(page.getByTestId("field-name")).toHaveValue(/\S+/);  // 名称从 SDK 获取，不为空即可
    await expect(page.locator('[data-testid="tag-input"]').getByText("deepseek-chat")).toBeVisible();

    // 补 apiKey 后保存
    await page.getByTestId("field-apiKey").fill("sk-e2e-preset");
    await page.getByTestId("provider-save-btn").click();
    await expect(page.getByTestId("provider-form-modal")).not.toBeVisible({ timeout: 3000 });
    // 本次新增的卡片出现（按内容作用域，不断言总数：全套 spec 共享 kernel 的 provider 列表）
    const card = page.locator('[data-testid^="provider-card-"]', { hasText: "deepseek-chat" });
    await expect(card).toBeVisible({ timeout: 5000 });

    // 自我清理：删除本次新增的供应商，避免污染后续用例
    await card.locator('[data-testid^="provider-delete-"]').click();
    await expect(page.getByTestId("confirm-dialog")).toBeVisible();
    await page.getByTestId("confirm-ok").click();
    await expect(card).toHaveCount(0, { timeout: 5000 });
  });
});
