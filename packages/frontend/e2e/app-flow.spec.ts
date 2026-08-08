import { test, expect } from "@playwright/test";
import { createProject, saveProvider } from "./helpers";

// Task 35-39 合并：完整应用流程 E2E
// 串行执行：第 1 个 test 建项目 + 预置假 provider（共享 kernel），后续 test goto 后有项目，
// 各自经 Composer 发消息进 session 测目标功能
test.describe.serial("应用主流程", () => {

// Task 35: 首次启动空态 → 建项目（只跑一次，为后续 test 提供项目）
// createProjectFromDir 现已改为打开目录树选择器（DirTreePicker，不再触发 window.prompt），
// 故 E2E 不再走 UI 选择器，直接经 REST 建测试项目，浏览器只断言结果（与 multi-project 一致的常规做法）。
test("首次启动空态引导建项目", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("empty-state")).toBeVisible();

  // 绕过 UI 选择器，直接 POST /api/projects 建项目
  const created = await createProject("e2e-main", "/tmp/e2e-main");
  expect(created).toBeTruthy();

  // 预置假 provider：新建会话页的 Composer 必须选模型才能发送（localhost:9999 不可达属预期）
  await saveProvider({
    id: "e2e-app-flow-provider",
    name: "E2E",
    baseUrl: "http://localhost:9999/v1",
    apiKey: "sk-e2e",
    api: "openai-completions",
    models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
  });

  // 项目出现后 view 由 empty 切到 new-session（projects.length > 0 且无 currentSessionId）
  await expect(page.getByTestId("new-session-pane")).toBeVisible({ timeout: 5000 });
  // 项目名出现在 sidebar
  await expect(page.getByText("e2e-main").first()).toBeVisible({ timeout: 5000 });
});

// 辅助：进入 session 视图（每个 test 的 page 是新的，需各自发消息进 session）
// 新建会话页现统一用 Composer（无独立 new-session-input/new-session-send），
// 流程对齐 quick-invoke.spec：选模型 → composer-input 输入 → composer-send
async function enterSession(page: import("@playwright/test").Page, text: string) {
  await page.goto("/");
  await expect(page.getByTestId("new-session-pane")).toBeVisible({ timeout: 5000 });
  // 必须先选择模型，否则发送按钮被禁用
  await page.getByTestId("model-selector").selectOption({ label: "E2E/model-a" });
  await page.locator('[data-testid="composer-input"] [role="textbox"]').click();
  await page.keyboard.type(text, { delay: 5 });
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 8000 });
}

// Task 36: 发首条消息建会话
test("发首条消息建会话并切到 session 视图", async ({ page }) => {
  await enterSession(page, "设计登录功能");
});

// Task 39: 编排画布显示 4 节点
test("编排画布显示 4 节点", async () => {
  // 编排画布功能已从前端移除（src 下无 canvas / canvas-node 相关组件与 testid），
  // 该用例保留占位待产品决策：恢复功能则重写断言，确认移除则删除
  test.skip(true, "编排画布功能已从前端移除，用例无法执行");
});

// Task 38: Agent 配置 modal 打开 + tab 切换
test("Agent 配置 modal 打开并切换 tab", async ({ page }) => {
  await enterSession(page, "配置测试会话");
  // 隔离环境仅内置 dev（displayName 研发，global-setup 预置；旧用例的「技术实现」已不存在）。
  // 详情弹窗现经侧栏右键【编辑智能体】打开（左键是带着预选切新建会话页）
  await page.getByTestId("agent-研发").click({ button: "right" });
  await page.getByTestId("agent-ctx-edit").click();
  await expect(page.getByTestId("agent-config")).toBeVisible();
  // tab 现为 基本/工具/技能/关系网：基本页含系统提示词 textarea
  await page.getByTestId("tab-basic").click();
  await expect(page.locator("textarea").first()).toBeVisible({ timeout: 5000 });
  await page.locator("textarea").first().fill("你是资深工程师 v2-e2e");
  await expect(page.locator("textarea").first()).toHaveValue("你是资深工程师 v2-e2e");
  await page.getByTestId("tab-partners").click();
  await expect(page.getByText(/可发起 ask/)).toBeVisible();
});

});
