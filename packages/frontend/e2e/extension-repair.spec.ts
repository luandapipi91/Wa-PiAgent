import { test, expect, type Page } from "@playwright/test";
import { createProject, saveProvider } from "./helpers";

// 修复依赖（extension:repair）E2E：确认弹窗流程 + 确认后发出 POST /api/extensions/repair。
// 不真实执行安装（30-60s 过重）：拦截请求，SSE 终态由组件/单测层覆盖。
//
// 语言锁定：E2E chromium 默认 locale en-US，界面语言随 navigator 检测漂移
// （settings-provider.spec.ts 的中文断言在该环境下会失败）。预置 wa-pi-ui-prefs
// localStorage 锁定中文（language-switch.spec.ts 同款），让「插件」导航与弹窗文案断言稳定。

/** 预置 ui-prefs localStorage 锁定中文（language-switch.spec.ts 同款）。 */
async function setZh(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      "wa-pi-ui-prefs",
      JSON.stringify({ state: { language: "zh", fontSize: 16, exportTurns: 1 }, version: 0 }),
    );
  });
}

/** 建项目让 sidebar 显示 → 打开设置 → 插件 tab（settings-provider / plugin-command-toggles 既有路径）。 */
async function openSettingsPlugins(page: Page) {
  // 预置假 provider 规避首启 onboarding 向导弹窗（automation.spec.ts 同款）
  await saveProvider({
    id: "e2e-ext-repair-provider",
    name: "E2E Repair",
    slug: "e2e_ext_repair",
    baseUrl: "http://localhost:9999/v1",
    apiKey: "sk-e2e",
    api: "openai-completions",
    models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
  });
  await page.goto("/");
  await createProject("e2e-ext-repair", "/tmp/e2e-ext-repair");
  await page.goto("/");
  await expect(page.getByTestId("settings-btn")).toBeVisible({ timeout: 8000 });
  await page.getByTestId("settings-btn").click();
  await expect(page.getByTestId("settings-modal")).toBeVisible();
  // settings-modal 的插件 nav 无 testid，按按钮文本精确匹配
  await page.getByRole("button", { name: "插件", exact: true }).click();
  await expect(page.getByTestId("ext-install-input")).toBeVisible();
}

test("修复依赖：确认后发出 repair 请求", async ({ page }) => {
  let repairRequested = false;
  await page.route("**/api/extensions/repair", async (route) => {
    repairRequested = true;
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });

  await setZh(page);
  await openSettingsPlugins(page);

  await page.getByTestId("ext-repair-btn").click();
  await expect(page.getByText("确认修复依赖")).toBeVisible();
  // 取消不发请求
  await page.getByTestId("confirm-cancel").click();
  expect(repairRequested).toBe(false);

  await page.getByTestId("ext-repair-btn").click();
  await page.getByTestId("confirm-ok").click();
  await expect
    .poll(() => repairRequested, { message: "应发出 POST /api/extensions/repair" })
    .toBe(true);
});

test("修复依赖：按钮存在且可点击", async ({ page }) => {
  await setZh(page);
  await openSettingsPlugins(page);
  await expect(page.getByTestId("ext-repair-btn")).toBeVisible();
});
