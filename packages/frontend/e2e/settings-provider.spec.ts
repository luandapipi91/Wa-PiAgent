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

    // 等待预设列表加载（聚焦搜索框出下拉，至少一个预设项）
    await page.getByTestId("preset-search").focus();
    await expect(page.getByTestId("preset-option").first()).toBeVisible({ timeout: 10000 });

    // 搜索并选 DeepSeek 预设 → 名称/Base URL 自动填入
    await page.getByTestId("preset-search").fill("deepseek");
    await page.locator('[data-testid="preset-option"][data-key="deepseek"]').click();
    await expect(page.getByTestId("field-name")).toHaveValue(/\S+/);  // 名称从 SDK 获取，不为空即可
    // 改成唯一名：共享 kernel 里其他 spec（chat-blocks）也注入过 deepseek-v4-flash 模型的
    // DeepSeek 卡片，按模型名定位会 strict 冲突
    await page.getByTestId("field-name").fill("E2E Preset Provider");

    // 选预设后模型列表清空，需经「模型快捷搜索」下拉逐个添加
    // （pi-ai 0.83 目录里 deepseek 只有 v4 系列，旧的 deepseek-chat 已不存在）
    await page.getByTestId("tag-input-field").focus();
    await page.getByTestId("tag-input-field").fill("deepseek-v4-flash");
    await page.locator('[data-testid="model-quick-option"]', { hasText: "deepseek-v4-flash" }).first().click();
    await expect(page.locator('[data-testid="tag-input"]').getByText("deepseek-v4-flash")).toBeVisible();

    // 补 apiKey 后保存
    await page.getByTestId("field-apiKey").fill("sk-e2e-preset");
    await page.getByTestId("provider-save-btn").click();
    await expect(page.getByTestId("provider-form-modal")).not.toBeVisible({ timeout: 3000 });
    // 本次新增的卡片出现（按内容作用域，不断言总数：全套 spec 共享 kernel 的 provider 列表）
    const card = page.locator('[data-testid^="provider-card-"]', { hasText: "deepseek-v4-flash" });
    await expect(card).toBeVisible({ timeout: 5000 });

    // 自我清理：删除本次新增的供应商，避免污染后续用例
    await card.locator('[data-testid^="provider-delete-"]').click();
    await expect(page.getByTestId("confirm-dialog")).toBeVisible();
    await page.getByTestId("confirm-ok").click();
    await expect(card).toHaveCount(0, { timeout: 5000 });
  });
});
