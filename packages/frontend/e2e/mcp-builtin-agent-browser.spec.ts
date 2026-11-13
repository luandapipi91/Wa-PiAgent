import { test, expect, type Page } from "@playwright/test";
import { ensureProvider } from "./helpers";

// 内置 agent-browser MCP 的 E2E：
//   ① MCP 管理页：条目常驻、无删除/编辑按钮、停用 switch 真实写盘并反映到徽标；
//   ② 浏览器缺失（global-setup 注入 doctor 结果）时出现「安装浏览器」按钮；
//   ③ 智能体详情 MCP tab：内置服务器像普通服务器一样有分组开关。
// E2E kernel 由 global-setup 启动（独立 WA_PI_DIR），内置条目在 kernel 启动时 ensure 物化。

async function navigateToMcp(page: Page) {
  await expect(page.getByTestId("settings-btn")).toBeVisible({ timeout: 8000 });
  await page.getByTestId("settings-btn").click();
  await expect(page.getByTestId("settings-modal")).toBeVisible();
  await page.getByTestId("settings-nav-mcp").click();
  await expect(page.getByTestId("mcp-page")).toBeVisible();
}

test.describe.serial("内置 agent-browser MCP", () => {
  // 无 provider 时 onboarding 向导会盖住设置按钮（modal-overlay 拦截点击）
  test.beforeAll(async () => {
    await ensureProvider();
  });

  test("内置条目：无删除/编辑按钮，可停用并恢复", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/");
    await navigateToMcp(page);
    const card = page.getByTestId("mcp-card-agent-browser");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId("mcp-delete-agent-browser")).toHaveCount(0);
    await expect(card.getByTestId("mcp-edit-agent-browser")).toHaveCount(0);

    const sw = page.getByTestId("mcp-switch-agent-browser");
    await expect(sw).toBeVisible();
    // 列表后台探测会持续更新状态、卡片节点可能被替换：直接派发 click，跳过 actionability 重试
    // 等首轮后台探测落定（否则在飞的旧探测结果会把停用状态覆盖回 connected）
    await expect(page.getByTestId("mcp-state-agent-browser")).toHaveAttribute(
      "data-state",
      "connected",
      { timeout: 30_000 },
    );
    await sw.dispatchEvent("click");
    await expect(page.getByTestId("mcp-state-agent-browser")).toHaveAttribute(
      "data-state",
      "disabled",
      { timeout: 30_000 },
    );
    await sw.dispatchEvent("click");
    await expect(page.getByTestId("mcp-state-agent-browser")).not.toHaveAttribute(
      "data-state",
      "disabled",
      { timeout: 30_000 },
    );
  });

  test("浏览器缺失时显示安装按钮", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto("/");
    await navigateToMcp(page);
    await expect(
      page.getByTestId("mcp-install-browser-agent-browser"),
    ).toBeVisible({ timeout: 30_000 });
  });

  test("智能体 MCP 页出现 agent-browser 分组开关", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/");
    await page.getByTestId("agent-collapsed").click();
    await expect(page.getByTestId("agent-gallery")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("gallery-card-研发").click({ button: "right" });
    await page.getByTestId("gallery-ctx-edit").click();
    await expect(page.getByTestId("agent-config")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("tab-mcp").click();
    await expect(
      page.getByTestId("mcp-group-switch-agent_browser"),
    ).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("agent-config-close").click();
  });
});
