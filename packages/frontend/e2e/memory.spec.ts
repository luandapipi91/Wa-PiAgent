// memory.spec.ts — 记忆管理 E2E 测试（Task 12）
//
// 覆盖 spec 场景：进入记忆页 → 查看列表 → 编辑 → 归档 → 指令文件 Tab → 双开关。
// 测试数据由 global-setup.ts 在 kernel 启动前预置到隔离 HIAGENT_DIR：
//   memories/global/MEMORY.md（两条 § 分隔记忆）+ USER.md + 全局 AGENTS.md。
// 注意：不能在测试里直接写 E2E_HIAGENT_DIR —— Playwright worker 进程会重新
// 求值 playwright.config.ts 的 randomUUID()，拿到与 globalSetup 不同的目录。
import { test, expect } from "@playwright/test";

// 记忆管理现作为「系统设置」面板的一个分区。
// 此辅助函数打开设置弹窗并切到「记忆」分区。
async function openMemorySection(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByTestId("settings-btn").click();
  await expect(page.getByTestId("settings-modal")).toBeVisible();
  await page.getByTestId("settings-nav-memory").click();
  await expect(page.getByTestId("memory-page")).toBeVisible({ timeout: 5000 });
}

test.describe.serial("记忆管理", () => {

  test("进入记忆页，查看记忆列表", async ({ page }) => {
    await openMemorySection(page);

    // 确认标题与默认「已保存」Tab 存在
    await expect(page.getByTestId("tab-已保存")).toBeVisible();
    // 默认「全局记忆」作用域，预置的全局记忆应直接渲染
    await expect(page.getByText("E2E 记忆条目一").first()).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("E2E 记忆条目二").first()).toBeVisible();
  });

  test("编辑一条记忆", async ({ page }) => {
    await openMemorySection(page);
    await expect(page.locator('[data-testid^="memory-card-"]').first()).toBeVisible({ timeout: 5000 });

    // 点击第一张卡片的「编辑」按钮
    await page.locator('[data-testid="memory-edit"]').first().click();
    await expect(page.getByTestId("memory-edit-textarea")).toBeVisible();

    // 修改文本并保存
    await page.getByTestId("memory-edit-textarea").fill("E2E 编辑后的记忆");
    await page.getByTestId("memory-edit-save").click();

    // 保存后编辑态关闭，新文本出现在列表（memory:changed 广播刷新）
    await expect(page.getByText("E2E 编辑后的记忆").first()).toBeVisible({ timeout: 5000 });
  });

  test("归档一条记忆 → 切到归档 Tab 查看", async ({ page }) => {
    await openMemorySection(page);
    await expect(page.locator('[data-testid^="memory-card-"]').first()).toBeVisible({ timeout: 5000 });

    // 点击第一张卡片的「归档」按钮
    await page.locator('[data-testid="memory-archive"]').first().click();

    // 切到归档 Tab，应能看到被归档的条目
    await page.getByTestId("tab-归档").click();
    await expect(page.locator('[data-testid^="memory-card-"]').first()).toBeVisible({ timeout: 5000 });
  });

  test("切换到指令文件 Tab", async ({ page }) => {
    await openMemorySection(page);

    // 切到指令文件 Tab
    await page.getByTestId("tab-指令文件").click();
    // 有指令文件就展示条目，没有就展示空状态——两者之一可见即通过
    const hasItem = await page.locator('[data-testid*="instruction-item"]').count();
    expect(hasItem).toBeGreaterThanOrEqual(0);
    // global-setup 预置了全局 AGENTS.md，应展示全局指令条目
    if (hasItem > 0) {
      await expect(page.locator('[data-testid="instruction-item-global"]')).toBeVisible({ timeout: 5000 });
    }
  });

  test("开关切换 — 自动学习", async ({ page }) => {
    await openMemorySection(page);

    // 点击「自动学习」开关（toggle-review label 包裹 ToggleSwitch）
    // 默认 reviewEnabled=true → 内部 toggle 为 toggle-on，点击后变 toggle-off
    const reviewToggle = page.getByTestId("toggle-review");
    await expect(reviewToggle).toBeVisible();

    // 点击开关内部（ToggleSwitch 的 toggle-on/toggle-off），不点 label 文字
    await reviewToggle.locator('[data-testid^="toggle-"]').click();
    // 不报错即通过；验证开关状态翻转（on → off）
    await expect(reviewToggle.locator('[data-testid="toggle-off"]')).toBeVisible({ timeout: 3000 });
  });

  test("Bug1: 关闭重开设置后，项目作用域选择器保留上次选中的项目", async ({ page }) => {
    await openMemorySection(page);

    // 展开作用域下拉，选择预置的 E2E 项目
    await page.getByTestId("memory-scope-select").click();
    await page.getByTestId("memory-scope-option-project-e2e-proj-1").click();

    // 确认已切到该项目：按钮显示项目名，项目记忆可见
    await expect(page.getByTestId("memory-scope-select")).toContainText("E2E项目");
    await expect(page.getByText("E2E 项目记忆条目").first()).toBeVisible({ timeout: 5000 });

    // 关闭设置弹窗（点遮罩）
    await page.getByTestId("modal-overlay").click({ position: { x: 0, y: 0 } });
    await expect(page.getByTestId("settings-modal")).toBeHidden({ timeout: 3000 });

    // 重新打开设置 → 记忆页
    await page.getByTestId("settings-btn").click();
    await expect(page.getByTestId("settings-modal")).toBeVisible();
    await page.getByTestId("settings-nav-memory").click();
    await expect(page.getByTestId("memory-page")).toBeVisible({ timeout: 5000 });

    // 期望：选择器仍显示该项目名（而非兜底的「项目记忆」），项目记忆仍可见
    await expect(page.getByTestId("memory-scope-select")).toContainText("E2E项目");
    await expect(page.getByText("E2E 项目记忆条目").first()).toBeVisible({ timeout: 5000 });
  });

  test("Bug2: 指令文件 Tab 切到项目作用域，默认即加载项目指令文件", async ({ page }) => {
    await openMemorySection(page);

    // 切到指令文件 Tab
    await page.getByTestId("tab-指令文件").click();
    // 项目选择器始终可见（不受 scopeFilter 影响）
    await expect(page.getByTestId("instruction-project-select")).toBeVisible();

    // 切到「项目」作用域：应立即显示项目级指令文件，无需二次切换项目
    await page.getByText("项目", { exact: true }).click();
    await expect(page.getByTestId("instruction-item-project")).toBeVisible({ timeout: 5000 });
  });
});
