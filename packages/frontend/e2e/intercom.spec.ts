import { test, expect } from "@playwright/test";

// Task 37: [需 pi 环境] 会话内 intercom 委派显示 AskCard
// 需要真实 pi + pi-intercom broker 运行，手动触发 ask 流程
test("[需 pi 环境] 会话内 intercom 委派显示 AskCard", async ({ page }) => {
  test.skip(!process.env.PI_E2E, "需真实 Pi 环境（PI_E2E=1 启用）");

  page.on("dialog", async d => {
    if (d.message().includes("项目名")) await d.accept("IntercomTest");
    else if (d.message().includes("cwd")) await d.accept("/tmp/intercom");
  });

  await page.goto("/");
  await page.getByTestId("empty-new-project").click();
  await page.getByTestId("new-session-input").fill("请 dev 评估登录方案");
  await page.getByTestId("new-session-send").click();
  await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 5000 });

  // 等待 intercom:ask 事件触发 AskCard 渲染（pi 真实环境可能需较久）
  await expect(page.getByText(/委派给/)).toBeVisible({ timeout: 30000 });
  await page.getByTestId("ask-answer-btn").click();
  await page.getByTestId("ask-input").fill("用 SSE 实现");
  await page.getByText("提交").click();
  await expect(page.getByText(/已回复/)).toBeVisible();
});
