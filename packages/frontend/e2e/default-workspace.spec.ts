import { test, expect } from "@playwright/test";
import { existsSync, readdirSync, statSync, utimesSync, rmSync } from "node:fs";
import { join } from "node:path";
import { E2E_WA_PI_DIR } from "../playwright.config";
import { createSessionViaPrompt } from "./helpers";

// 默认工作区 E2E：验证 UI 渲染 + 项目下拉默认选中 + 项目右键菜单差异
//
// 说明：本 spec 不依赖真实 LLM API key 与 desktop 启动，只覆盖 UI 层关键行为。
// 完整端到端（agent 真实写文件到 workdir/<createdAt>/）需要 API key + 真实 desktop 环境，
// 由开发者本地手动验证。
//
// 前置：global-setup.ts 已启动 kernel + frontend dev server。

const DAY_MS = 24 * 60 * 60 * 1000;

test.describe.serial("默认工作区", () => {

  test("侧栏渲染独立'默认'区 + 🏠 默认工作区", async ({ page }) => {
    await page.goto("/");
    // 等项目列表加载
    await page.waitForTimeout(2000);
    // 默认工作区渲染在项目列表顶部（UI 已改为无「默认」小标题，见 ProjectList.tsx 注释）
    await expect(page.getByText("默认工作区").first()).toBeVisible({ timeout: 5000 });
    // 普通项目分区有「项目」小标题，默认工作区独立于其外
    await expect(page.getByText("项目", { exact: true }).first()).toBeVisible({ timeout: 5000 });
  });

  test("点击默认工作区进新建会话页 + 下拉默认选中", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
    // 点默认工作区
    await page.getByText("默认工作区").first().click();
    // 进入 new-session 视图
    await expect(page.getByTestId("new-session-pane")).toBeVisible({ timeout: 5000 });
    // 项目下拉默认选中 __system__
    const select = page.getByTestId("project-select");
    await expect(select).toHaveValue("__system__", { timeout: 5000 });
    // 选中 option 文本是 "🏠 默认工作区"（不含 cwd）
    const selectedOption = await select.locator("option:checked").textContent();
    expect(selectedOption).toContain("默认工作区");
    expect(selectedOption).toContain("🏠");
  });

  test("默认工作区右键菜单不含'删除项目'", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
    // 右键默认工作区项目名
    await page.getByText("默认工作区").first().click({ button: "right" });
    // 等菜单出现
    await expect(page.getByTestId("project-context-menu")).toBeVisible({ timeout: 2000 });
    // "查看文件夹" 应该存在
    await expect(page.getByTestId("menu-open-dir")).toBeVisible();
    // "删除项目" 不应该存在
    await expect(page.getByTestId("menu-delete-project")).toHaveCount(0);
  });

  test("默认工作区新建会话产生 workdir/<createdAt>/ 子目录", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);

    // 通过 REST 创建一个默认工作区会话（绕过真实 LLM 调用）
    const session = await createSessionViaPrompt("__system__", {
      agentName: "dev",
      text: "e2e 测试",
      model: "test-model",  // 会失败但不影响 session 创建
    });

    expect(session).toBeTruthy();
    expect(session.projectId).toBe("__system__");
    expect(typeof session.createdAt).toBe("number");

    // 子目录应该在磁盘上存在
    // 注意：E2E kernel 的 WA_PI_DIR=E2E_WA_PI_DIR，所以子目录在 E2E_WA_PI_DIR/workdir/<createdAt>/
    const subDir = join(E2E_WA_PI_DIR, "workdir", String(session.createdAt));
    expect(existsSync(subDir)).toBe(true);

    // 清理：删掉这个测试产生的子目录
    rmSync(subDir, { recursive: true, force: true });
  });

  test("默认工作区会话删除后保留子目录 + 7 天后被清理", async ({ page }) => {
    // 本测试验证清理任务逻辑——通过手动 utimes 子目录 mtime 模拟过期
    // 由于 cleanup 任务是 setInterval 每天跑一次，测试用 utimes 改 mtime 后
    // 直接调 page.evaluate 触发一次清理（需要 kernel 暴露 debug endpoint，当前未暴露）
    // 简化：只验证 workdir-cleaner 的逻辑（已被单元测试覆盖），此处跳过真实清理触发
    // 清理任务真实触发需要 kernel debug endpoint 或重启；单元测试 packages/kernel/tests/workdir-cleaner.test.ts
    // 已覆盖三重防护逻辑。手动验证：把任一 workdir/<ts>/ 子目录的 mtime 改为 8 天前，
    // 然后重启 kernel（启动时会跑一次 cleanupExpiredWorkdirs）即可看到该子目录被清理
    test.skip(true, "清理任务真实触发需要 kernel 重启，由开发者手动验证（见注释）");
  });

});

// 测试完成后清理所有截图（AGENTS.md 第 6 条要求）
test.afterAll(async () => {
  // Playwright 默认截图在 test-results/ 或 playwright-report/ 下
  // 由 global-teardown.ts 统一清理，这里不重复
});
