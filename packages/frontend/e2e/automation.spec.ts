import { test, expect } from "@playwright/test";
import { E2E_WS_PORT } from "../playwright.config";
import { saveProvider } from "./helpers";

// 定时任务系统 E2E：任务 10（规格场景 ①⑤ 的浏览器端全链路）
//
// 覆盖（serial 连贯流）：
// 1. 切换 automation 页签 → 侧边栏任务列表 + 主区头部可见（初始空态）
// 2. 新建完整流程：+ 新建 → 填名称 → 选计划类型(每周) → 选执行角色 → 填指令 → 保存
//    → 回 detail 视图 → 任务卡片出现在侧边栏
// 3. 点击任务卡片 → TaskDetailView 四宫格（计划/角色）+ 任务指令
// 4. 侧边栏「执行记录」入口 → ExecutionRecords 空态渲染 → 点任务卡片回 detail
// 5. 清理：REST DELETE 测试任务 → SSE 驱动列表恢复空态
//
// 环境说明：
// - 执行角色「研发」由 global-setup 预置（agents/dev.md，displayName=研发）；
//   kernel 以 WA_PI_SKIP_AGENT_SEED=1 启动，无内置角色干扰。
// - App.tsx 监听 scheduled-tasks:changed SSE 事件重拉任务列表，删除后 UI 自动刷新。
// - 任务 id 不在 UI 暴露，经 REST GET /api/scheduled-tasks 按名称取（helpers.ts 未导出
//   通用 api，本 spec 局部实现同风格 fetch）。
//
// 清理：taskId 经 REST DELETE 幂等删除（afterAll 兜底 + 用例 5 内联验证删除生效）。

const BASE = `http://127.0.0.1:${E2E_WS_PORT}`;
const TASK_NAME = "E2E 测试任务";

/** 底层 REST 调用：非 2xx 抛错，返回解析后的 body（风格对齐 e2e/helpers.ts） */
async function api<T = any>(method: string, path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`REST ${method} ${path} 失败(${res.status}): ${data?.error ?? ""}`);
  }
  return data as T;
}

/** 轮询任务列表直到指定名称的任务出现（保存是 UI 触发的异步 POST） */
async function findTaskByName(name: string): Promise<any> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const data = await api<{ tasks: any[] }>("GET", "/api/scheduled-tasks");
    const hit = (data.tasks ?? []).find((t) => t.name === name);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error(`任务未出现: ${name}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** 清理用删除：忽略任务不存在的报错，永不抛出 */
async function deleteTaskQuiet(id: string): Promise<void> {
  if (!id) return;
  try {
    await api("DELETE", `/api/scheduled-tasks/${id}`);
  } catch {
    /* 忽略：任务可能已被用例 5 删除 */
  }
}

test.describe.serial("定时任务自动化", () => {
  let taskId = "";

  test.beforeAll(async () => {
    // 预置假 provider：隔离环境默认无 provider，App 首启弹 onboarding 向导
    // （modal-overlay）拦截点击（同 streaming-render-perf.spec.ts 模式）
    await saveProvider({
      id: "e2e-automation-provider",
      name: "E2E Automation",
      slug: "e2e-automation",
      baseUrl: "http://localhost:9999/v1",
      apiKey: "sk-e2e",
      api: "openai-completions",
      models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
    });
  });

  test.beforeEach(async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto("/", { timeout: 60_000 });
    // 切换到自动化 Tab（侧边栏分段标签 tasks | im | automation）
    await page.getByTestId("sidebar-tab-automation").click();
    await expect(page.getByTestId("automation-sidebar")).toBeVisible({
      timeout: 10_000,
    });
  });

  test.afterAll(async () => {
    await deleteTaskQuiet(taskId);
  });

  test("1 切换 automation 页签：任务列表容器与主区头部可见，初始空态", async ({ page }) => {
    const sidebar = page.getByTestId("automation-sidebar");
    await expect(sidebar).toContainText("定时任务");
    await expect(page.getByTestId("automation-main-header")).toContainText("定时任务");
    // 干净隔离环境无预置任务 → 空态文案
    await expect(page.getByText("暂无定时任务")).toBeVisible();
  });

  test("2 新建定时任务完整流程：填表单 → 保存 → 列表展示", async ({ page }) => {
    // 点击「+ 新建」进入编辑视图
    await page.getByTestId("automation-new-btn").click();
    const form = page.getByTestId("task-edit-form");
    await expect(form).toBeVisible();
    await expect(page.getByTestId("automation-main-header")).toContainText("新建定时任务");

    // 填任务名称
    await page.getByTestId("task-name-input").fill(TASK_NAME);

    // 计划类型选「每周」（表单内第一个 select），周几保持默认（周一）
    await form.locator("select").first().selectOption("weekly");

    // 选择执行角色（global-setup 预置的「研发」）
    await page.getByText("研发", { exact: true }).click();

    // 填任务指令
    await page.getByTestId("task-prompt-input").fill("E2E：请整理今日文件");

    // 必填齐全后保存按钮可用 → 点击保存
    const save = page.getByTestId("task-save-btn");
    await expect(save).toBeEnabled();
    await save.click();

    // 保存成功后回 detail 视图：selectedTaskId 被重置 → 空态提示
    await expect(page.getByText("选择一个任务查看详情")).toBeVisible();

    // 任务卡片出现在侧边栏（id 经 REST 查询，UI 不暴露）
    taskId = (await findTaskByName(TASK_NAME)).id;
    const card = page.getByTestId(`automation-task-${taskId}`);
    await expect(card).toBeVisible();
    await expect(card).toContainText(TASK_NAME);
  });

  test("3 点击任务卡片：详情视图展示四宫格与任务指令", async ({ page }) => {
    const card = page.getByTestId(`automation-task-${taskId}`);
    await expect(card).toBeVisible();
    await card.click();

    const detail = page.getByTestId("task-detail-view");
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("计划时间");
    await expect(detail).toContainText("每周一 09:00"); // weekly + 默认周一 + 默认时间
    await expect(detail).toContainText("执行角色");
    await expect(detail).toContainText("研发");
    await expect(detail).toContainText("E2E：请整理今日文件");
  });

  test("4 切换到执行记录视图：空态渲染，点任务卡片返回详情", async ({ page }) => {
    // 侧边栏「执行记录」入口 → records 视图
    await page.getByTestId("automation-records-btn").click();
    await expect(page.getByTestId("execution-records")).toBeVisible();
    await expect(page.getByTestId("automation-main-header")).toContainText("执行记录");
    // 隔离环境从未执行任务 → 空态文案
    await expect(page.getByText("暂无执行记录")).toBeVisible();

    // 点侧边栏任务卡片（selectTask 会把视图切回 detail）→ 详情可见
    await page.getByTestId(`automation-task-${taskId}`).click();
    await expect(page.getByTestId("task-detail-view")).toBeVisible();
  });

  test("5 清理：REST 删除测试任务，SSE 驱动列表恢复空态", async ({ page }) => {
    await deleteTaskQuiet(taskId);

    // 不 reload：kernel 广播 scheduled-tasks:changed → App 重拉任务列表 → 空态自动出现，
    // 顺带验证 SSE 刷新链路
    await expect(page.getByText("暂无定时任务")).toBeVisible({ timeout: 10_000 });
    taskId = ""; // 已删，跳过 afterAll 兜底
  });
});
