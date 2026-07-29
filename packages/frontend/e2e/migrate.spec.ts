import { test, expect } from "@playwright/test";

// Task 41: [需 pi 环境] 老数据迁移
// 预置：kernel 启动前在 E2E_WA_PI_DIR 放无 projectId 的旧 projects.json（含孤儿 session）
// kernel globalSetup 启动时 migrateLegacySessions 自动建「默认项目」
// 注：此 spec 依赖 globalSetup 注入老数据，当前 globalSetup 未预置老数据，标记为骨架
test("[需 pi 环境] 老用户首次启动自动建默认项目", async ({ page }) => {
  test.skip(!process.env.PI_E2E, "需真实 Pi 环境 + 预置老数据（PI_E2E=1 启用）");
  await page.goto("/");
  // 迁移后 sidebar 应显示「默认项目」
  await expect(page.getByText("默认项目")).toBeVisible({ timeout: 5000 });
});
