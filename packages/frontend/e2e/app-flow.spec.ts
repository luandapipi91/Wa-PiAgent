import { test, expect } from "@playwright/test";

// Task 35-39 合并：完整应用流程 E2E
// 串行执行：第 1 个 test 建项目（共享 kernel），后续 test goto 后有项目，各自发消息进 session 测目标功能
test.describe.serial("应用主流程", () => {

// Task 35: 首次启动空态 → 建项目（只跑一次，为后续 test 提供项目）
test("首次启动空态引导建项目", async ({ page }) => {
  page.on("dialog", async d => {
    if (d.message().includes("项目名")) await d.accept("E2E主项目");
    else if (d.message().includes("cwd")) await d.accept("/tmp/e2e-main");
  });
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();
  await page.getByTestId("empty-new-project").click();
  await expect(page.getByTestId("new-session-pane")).toBeVisible({ timeout: 5000 });
});

// 辅助：进入 session 视图（每个 test 的 page 是新的，需各自发消息进 session）
async function enterSession(page: import("@playwright/test").Page, text: string) {
  await page.goto("/");
  await expect(page.getByTestId("new-session-pane")).toBeVisible({ timeout: 5000 });
  await page.getByTestId("new-session-input").fill(text);
  await page.getByTestId("new-session-send").click();
  await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 5000 });
}

// Task 36: 发首条消息建会话
test("发首条消息建会话并切到 session 视图", async ({ page }) => {
  await enterSession(page, "设计登录功能");
});

// Task 39: 编排画布显示 4 节点
test("编排画布显示 4 节点", async ({ page }) => {
  await enterSession(page, "画布测试会话");
  await page.getByText("编排画布").click();
  await expect(page.getByTestId("canvas")).toBeVisible({ timeout: 5000 });
  await expect(page.locator("[data-testid^='canvas-node-']")).toHaveCount(4);
});

// Task 38: Agent 配置 modal 打开 + tab 切换
test("Agent 配置 modal 打开并切换 tab", async ({ page }) => {
  await enterSession(page, "配置测试会话");
  await page.getByTestId("agent-dev").click();
  await expect(page.getByTestId("agent-config")).toBeVisible();
  await page.getByText("系统提示词").click();
  await expect(page.locator("textarea").first()).toBeVisible({ timeout: 5000 });
  await page.locator("textarea").first().fill("你是资深工程师 v2-e2e");
  await expect(page.locator("textarea").first()).toHaveValue("你是资深工程师 v2-e2e");
  await page.getByText("合作伙伴").click();
  await expect(page.getByText(/可发起 ask/)).toBeVisible();
});

});
