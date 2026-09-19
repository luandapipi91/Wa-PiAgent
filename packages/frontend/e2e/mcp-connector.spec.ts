import { test, expect } from "@playwright/test";

// MCP 连接器 E2E 测试。
// E2E kernel 由 global-setup 预置项目 "e2e-proj-1"，无需额外创建项目。
test.describe.serial("MCP 连接器", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  // 辅助：打开设置并切换到 MCP 标签
  async function navigateToMcp(page: import("@playwright/test").Page) {
    await expect(page.getByTestId("settings-btn")).toBeVisible({
      timeout: 8000,
    });
    await page.getByTestId("settings-btn").click();
    await expect(page.getByTestId("settings-modal")).toBeVisible();
    await page.getByTestId("settings-nav-mcp").click();
    await expect(page.getByTestId("mcp-page")).toBeVisible();
  }

  test("进入 MCP 连接器页面", async ({ page }) => {
    await navigateToMcp(page);
    await expect(page.getByText("🔌 MCP 连接器")).toBeVisible();
  });

  test("全局作用域添加服务器", async ({ page }) => {
    await navigateToMcp(page);

    // 点击添加
    await page.getByTestId("mcp-add-button").click();
    await expect(page.getByTestId("mcp-form")).toBeVisible();

    // 填写表单
    await page.getByTestId("mcp-form-name").fill("e2e-test-server");
    await page.getByTestId("mcp-form-command").fill("echo");
    await page.getByTestId("mcp-form-args").fill("hello");

    // 保存
    await page.getByTestId("mcp-form-save").click();

    // 等待 WS 广播 mcp:changed 后卡片出现
    await expect(page.getByTestId("mcp-card-e2e-test-server")).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText("e2e-test-server")).toBeVisible();
  });

  test("项目作用域切换", async ({ page }) => {
    await navigateToMcp(page);

    // 打开作用域下拉
    await page.getByTestId("mcp-scope-select").click();
    await expect(page.getByTestId("mcp-scope-menu")).toBeVisible();

    // 选择预置项目
    const projectOption = page
      .locator('[data-testid^="mcp-scope-option-project-"]')
      .first();
    if (await projectOption.isVisible()) {
      await projectOption.click();
      // 列表切换到项目作用域
      await expect(page.getByTestId("mcp-page")).toBeVisible();
    }
  });

  test("编辑服务器", async ({ page }) => {
    await navigateToMcp(page);

    // 添加一个服务器用于编辑
    await page.getByTestId("mcp-add-button").click();
    await page.getByTestId("mcp-form-name").fill("edit-test");
    await page.getByTestId("mcp-form-command").fill("original-cmd");
    await page.getByTestId("mcp-form-save").click();

    // 等待编辑按钮出现（保存完成信号）
    await expect(page.getByTestId("mcp-edit-edit-test")).toBeVisible({
      timeout: 15000,
    });

    // 点击编辑按钮
    await page.getByTestId("mcp-edit-edit-test").click();
    await expect(page.getByTestId("mcp-form")).toBeVisible();

    // 表单预填了值
    const cmdInput = page.getByTestId("mcp-form-command");
    await expect(cmdInput).toHaveValue("original-cmd");

    // 修改并保存
    await cmdInput.fill("updated-cmd");
    await page.getByTestId("mcp-form-save").click();

    // 验证更新后的命令文本显示在卡片中
    await expect(page.getByText("updated-cmd")).toBeVisible({
      timeout: 15000,
    });
  });

  test("查看工具", async ({ page }) => {
    await navigateToMcp(page);

    // 添加一个服务器
    await page.getByTestId("mcp-add-button").click();
    await page.getByTestId("mcp-form-name").fill("tools-test");
    await page.getByTestId("mcp-form-command").fill("echo");
    await page.getByTestId("mcp-form-save").click();

    // 等待工具按钮出现（保存完成信号）
    await expect(page.getByTestId("mcp-tools-tools-test")).toBeVisible({
      timeout: 15000,
    });

    // 点击查看工具按钮
    await page.getByTestId("mcp-tools-tools-test").click();
    await expect(page.getByTestId("mcp-tools-modal")).toBeVisible();

    // 关闭
    await page.getByText("✕").click();
    await expect(page.getByTestId("mcp-tools-modal")).not.toBeVisible();
  });

  test("删除服务器", async ({ page }) => {
    await navigateToMcp(page);

    // 添加服务器用于删除
    await page.getByTestId("mcp-add-button").click();
    await page.getByTestId("mcp-form-name").fill("delete-test");
    await page.getByTestId("mcp-form-command").fill("echo");
    await page.getByTestId("mcp-form-save").click();

    // 等待删除按钮出现（保存完成信号）
    await expect(page.getByTestId("mcp-delete-delete-test")).toBeVisible({
      timeout: 15000,
    });

    await expect(page.getByText("delete-test")).toBeVisible();

    // 删除
    await page.getByTestId("mcp-delete-delete-test").click();

    // 确认弹窗
    await expect(page.getByTestId("confirm-dialog")).toBeVisible();
    await page.getByTestId("confirm-ok").click();

    // 服务器卡片消失
    await expect(page.getByText("delete-test")).not.toBeVisible({
      timeout: 15000,
    });
  });
});
