import { test, expect } from "@playwright/test";

test.describe.serial("设置页供应商管理", () => {

  test("打开设置页", async ({ page }) => {
    await page.goto("/");
    // 先建项目让 sidebar 显示（复用 app-flow 的模式）
    await page.evaluate(async () => {
      const ws = new WebSocket("ws://127.0.0.1:9776");
      await new Promise<void>((res) => { ws.addEventListener("open", () => res(), { once: true }); });
      ws.send(JSON.stringify({ type: "project:create", name: "e2e-settings", cwd: "/tmp/e2e-settings" }));
      await new Promise(r => setTimeout(r, 300));
      ws.close();
    });

    await page.goto("/");
    await expect(page.getByTestId("settings-btn")).toBeVisible({ timeout: 5000 });
    await page.getByTestId("settings-btn").click();
    await expect(page.getByTestId("settings-modal")).toBeVisible();
    await expect(page.getByText("模型管理")).toBeVisible();
  });

  test("添加供应商完整流程", async ({ page }) => {
    await page.goto("/");
    // 确保有项目（serial 共享 kernel，可能上一步已建）
    await page.evaluate(async () => {
      const ws = new WebSocket("ws://127.0.0.1:9776");
      await new Promise<void>((res) => { ws.addEventListener("open", () => res(), { once: true }); });
      ws.send(JSON.stringify({ type: "project:create", name: "e2e-settings", cwd: "/tmp/e2e-settings" }));
      await new Promise(r => setTimeout(r, 200));
      ws.close();
    });

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
    // 卡片出现
    await expect(page.locator('[data-testid^="provider-card-"]')).toHaveCount(1, { timeout: 5000 });
    await expect(page.getByText("E2E Test Provider")).toBeVisible();
  });

  test("删除供应商流程", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(async () => {
      const ws = new WebSocket("ws://127.0.0.1:9776");
      await new Promise<void>((res) => { ws.addEventListener("open", () => res(), { once: true }); });
      ws.send(JSON.stringify({ type: "project:create", name: "e2e-settings", cwd: "/tmp/e2e-settings" }));
      await new Promise(r => setTimeout(r, 200));
      ws.close();
    });

    await page.goto("/");
    await page.getByTestId("settings-btn").click();

    // 等待供应商卡片出现（上一步添加的）
    const deleteBtn = page.locator('[data-testid^="provider-delete-"]').first();
    await expect(deleteBtn).toBeVisible({ timeout: 5000 });
    await deleteBtn.click();

    // ConfirmDialog
    await expect(page.getByTestId("confirm-dialog")).toBeVisible();
    await page.getByTestId("confirm-ok").click();

    // 卡片消失
    await expect(page.locator('[data-testid^="provider-card-"]')).toHaveCount(0, { timeout: 5000 });
  });

  test("快捷选择预设填充表单并保存", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(async () => {
      const ws = new WebSocket("ws://127.0.0.1:9776");
      await new Promise<void>((res) => { ws.addEventListener("open", () => res(), { once: true }); });
      ws.send(JSON.stringify({ type: "project:create", name: "e2e-settings", cwd: "/tmp/e2e-settings" }));
      await new Promise(r => setTimeout(r, 200));
      ws.close();
    });

    await page.goto("/");
    await page.getByTestId("settings-btn").click();
    await page.getByTestId("add-provider-btn").click();

    // 选 DeepSeek 预设 → 字段被自动填入
    await page.getByTestId("preset-select").selectOption("deepseek");
    await expect(page.getByTestId("field-name")).toHaveValue("DeepSeek");
    await expect(page.getByTestId("field-baseUrl")).toHaveValue("https://api.deepseek.com");
    await expect(page.locator('[data-testid="tag-input"]').getByText("deepseek-chat")).toBeVisible();

    // 补 apiKey 后保存
    await page.getByTestId("field-apiKey").fill("sk-e2e-preset");
    await page.getByTestId("provider-save-btn").click();
    await expect(page.getByTestId("provider-form-modal")).not.toBeVisible({ timeout: 3000 });
    await expect(page.locator('[data-testid^="provider-card-"]')).toHaveCount(1, { timeout: 5000 });
    await expect(page.locator('[data-testid^="provider-card-"]').getByText("deepseek-chat")).toBeVisible();

    // 自我清理：删除本次新增的供应商，避免污染 serial 计数
    const deleteBtn = page.locator('[data-testid^="provider-delete-"]').first();
    await expect(deleteBtn).toBeVisible({ timeout: 5000 });
    await deleteBtn.click();
    await expect(page.getByTestId("confirm-dialog")).toBeVisible();
    await page.getByTestId("confirm-ok").click();
    await expect(page.locator('[data-testid^="provider-card-"]')).toHaveCount(0, { timeout: 5000 });
  });
});
