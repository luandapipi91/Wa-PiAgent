import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_HIAGENT_DIR, E2E_WS_PORT } from "../playwright.config";

// Task 18: 多智能体矩阵关键链路 E2E
//
// 覆盖（串行连贯流）：
// 1. 侧边栏默认 ≤3 个智能体 + 第 4 个出现后出「更多智能体」入口
// 2. 宫格弹窗：打开 → 卡片 → UI 新建 → 右键【编辑智能体】进详情弹窗
// 3. 详情弹窗：改简介 + 加关键词 + 关系网勾选 + 保存 → 宫格卡片简介更新（并重开验证持久化）
// 4. 左键智能体 → 新建会话页预选 → 发消息 → 会话出现且顶部 pill 为该智能体
// 5. 会话中切换：pill 下拉搜索 → 选择 →【继续切换】→「已切换为」分隔行
// 6. Composer：@ 出智能体补全（选中联动 agent-select）、# 出文件补全
// 7. 删除智能体：右键删除 → 二次确认 → 列表消失；会话保留 → 发消息出 agent_missing 重选弹窗 → 点选恢复
//
// 环境说明（与简报的偏差）：
// - global-setup 在 kernel 启动前预置了 agents/dev.md，kernel seedDefaults 因目录非空被跳过，
//   隔离环境初始只有 1 个智能体（dev），不会 seed product/pm/dev/test 四个。
// - 因此场景 1 的「第 4 个智能体」经 WS agent:create 补数据（UI 新建入口此时不可达：
//   侧栏空态新建仅 0 个智能体时出现，宫格入口 agent-more 要 >3 个才显示，存在先有鸡先有蛋问题）；
//   UI 新建路径在场景 2 经宫格 gallery-create 完整覆盖。
// - 假 provider（localhost:9999）无法产出 assistant 回复：相关断言只落在不依赖模型回复的 UI 状态
//   （pill / 分隔行 / 弹窗），发送失败产生的错误消息不影响断言。
//
// 清理：每个 test 创建的智能体在 finally 中经 WS agent:delete 删除（幂等，忽略报错）；
// 测试文件写在隔离 HIAGENT_DIR 内，global-teardown 统一删除。

/** 通过 WS 发送消息并等待 settle（可选等待特定响应类型），模式同 quick-invoke.spec.ts */
async function wsSend(payload: object, waitForType?: string, timeoutMs = 5000): Promise<any> {
  const ws = new WebSocket(`ws://127.0.0.1:${E2E_WS_PORT}`);
  await new Promise<void>((res, rej) => {
    ws.addEventListener("open", () => res(), { once: true });
    ws.addEventListener("error", () => rej(new Error("ws connect failed")), { once: true });
  });
  try {
    if (waitForType) {
      const result = new Promise<any>((res, rej) => {
        const timer = setTimeout(() => rej(new Error(`等待 ${waitForType} 超时`)), timeoutMs);
        ws.addEventListener("message", (ev) => {
          const e = JSON.parse(String((ev as MessageEvent).data));
          if (e.type === waitForType) { clearTimeout(timer); res(e); }
        });
      });
      // 必须先 send 再 await：否则 await 阻塞导致 send 永远执行不到（死锁超时）
      ws.send(JSON.stringify(payload));
      return await result;
    }
    ws.send(JSON.stringify(payload));
    await new Promise(r => setTimeout(r, 300));
    return undefined;
  } finally {
    ws.close();
  }
}

/** 清理用删除：忽略智能体不存在的报错，永不抛出 */
async function deleteAgentQuiet(name: string): Promise<void> {
  try { await wsSend({ type: "agent:delete", name }); } catch { /* 忽略 */ }
}

const A1 = "e2e-a1";
const A2 = "e2e-a2";
const A3 = "e2e-a3";
const UI_AGENT = "e2e-ui";

test.describe.serial("多智能体矩阵关键链路", () => {
  let projectId = "";
  let projectCwd = "";
  let sessionId = "";

  test.beforeEach(async ({ page }) => {
    test.setTimeout(120_000);
    // 共享项目 + 假 provider 只建一次（kernel 侧持久化，后续 test 复用）
    if (!projectId) {
      projectCwd = join(E2E_HIAGENT_DIR, "agents-e2e-proj");
      const created = await wsSend({
        type: "project:create",
        name: `e2e-agents-${randomUUID().slice(0, 8)}`,
        cwd: projectCwd,
      }, "project:created");
      projectId = created.project.id;
      await wsSend({
        type: "provider:save",
        provider: {
          id: "e2e-agents-provider",
          name: "E2E",
          baseUrl: "http://localhost:9999/v1",
          apiKey: "sk-e2e",
          api: "openai-completions",
          models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
        },
      });
    }
    await page.goto("/", { timeout: 60_000 });
  });

  test.afterAll(async () => {
    // 安全网：finally 未执行到时兜底清理（隔离目录每次 run 重建，主要防用例间污染）
    for (const name of [A1, A2, A3, UI_AGENT]) await deleteAgentQuiet(name);
  });

  test("1 侧边栏默认 ≤3 个智能体，第 4 个出现后有「更多智能体」入口", async ({ page }) => {
    // 初始仅 dev（global-setup 预置），无更多入口
    await expect(page.getByTestId("agent-dev")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("agent-more")).toHaveCount(0);

    // 经 WS 补足到 4 个（UI 新建入口此时不可达，见文件头说明）；广播 agent:list 驱动侧栏刷新
    await wsSend({ type: "agent:create", displayName: A1 }, "agent:created");
    await wsSend({ type: "agent:create", displayName: A2 }, "agent:created");
    await wsSend({ type: "agent:create", displayName: A3 }, "agent:created");

    // 侧栏只展示前 3 个（无会话时按名称序：dev / e2e-a1 / e2e-a2），第 4 个进「更多智能体」
    await expect(page.getByTestId(`agent-${A1}`)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId(`agent-${A2}`)).toBeVisible();
    await expect(page.getByTestId(`agent-${A3}`)).toHaveCount(0);
    await expect(page.getByTestId("agent-more")).toBeVisible();
    await expect(page.getByTestId("agent-more")).toContainText("(1)");
  });

  test("2 宫格弹窗：打开 → 卡片 → UI 新建 → 右键编辑进详情弹窗", async ({ page }) => {
    try {
      await page.getByTestId("agent-more").click();
      await expect(page.getByTestId("agent-gallery")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId("gallery-card-dev")).toBeVisible();
      await expect(page.getByTestId(`gallery-card-${A1}`)).toBeVisible();

      // 宫格内 UI 新建：确定后按乐观打开契约直接进入详情弹窗
      await page.getByTestId("gallery-create").click();
      await page.getByTestId("gallery-create-input").fill(UI_AGENT);
      await page.getByTestId("gallery-create-ok").click();
      await expect(page.getByTestId("agent-config")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId("cfg-name-input")).toHaveValue(UI_AGENT, { timeout: 10_000 });
      await page.getByTestId("agent-config").getByRole("button", { name: "取消" }).click();

      // 重开宫格：新卡片出现
      await page.getByTestId("agent-more").click();
      await expect(page.getByTestId(`gallery-card-${UI_AGENT}`)).toBeVisible({ timeout: 10_000 });

      // 右键卡片 →【编辑智能体】→ 详情弹窗
      await page.getByTestId(`gallery-card-${A1}`).click({ button: "right" });
      await page.getByTestId("gallery-ctx-edit").click();
      await expect(page.getByTestId("agent-config")).toBeVisible();
      await expect(page.getByTestId("cfg-name-input")).toHaveValue(A1, { timeout: 10_000 });
      await page.getByTestId("agent-config").getByRole("button", { name: "取消" }).click();
    } finally {
      await deleteAgentQuiet(UI_AGENT);
    }
  });

  test("3 详情弹窗：改简介 + 关键词 + 关系网 + 保存 → 宫格卡片简介更新", async ({ page }) => {
    const cfg = page.getByTestId("agent-config");
    await page.getByTestId("agent-more").click();
    await page.getByTestId(`gallery-card-${A1}`).click({ button: "right" });
    await page.getByTestId("gallery-ctx-edit").click();
    await expect(cfg).toBeVisible();
    await expect(page.getByTestId("cfg-name-input")).toHaveValue(A1, { timeout: 10_000 });

    // 基本：改简介 + 加关键词
    await cfg.locator("label", { hasText: "简介" }).locator("input").fill("E2E 矩阵简介");
    await page.getByTestId("kw-input").fill("矩阵词");
    await page.getByTestId("kw-input").press("Enter");
    await expect(page.getByTestId("kw-chip-矩阵词")).toBeVisible();

    // 关系网：勾选 dev（自身禁用不可勾）
    await page.getByTestId("tab-partners").click();
    await expect(page.getByTestId("partner-search")).toBeVisible();
    await page.getByTestId("partner-check-dev").click();
    await expect(page.getByTestId("partner-check-dev")).toBeChecked();
    await expect(page.getByTestId(`partner-check-${A1}`)).toBeDisabled();

    await cfg.getByRole("button", { name: "保存" }).click();
    await expect(cfg).toHaveCount(0);

    // config:save 保存后 kernel 广播 agent:list（含非改名路径），store 实时刷新：
    // 不 reload，重开宫格直接断言卡片简介已变为新值
    await page.getByTestId("agent-more").click();
    await expect(page.getByTestId(`gallery-card-${A1}`)).toContainText("E2E 矩阵简介", { timeout: 10_000 });

    // 重开详情弹窗验证保存已持久化到 kernel（agent:config:get 重取文件）
    await page.getByTestId(`gallery-card-${A1}`).click({ button: "right" });
    await page.getByTestId("gallery-ctx-edit").click();
    await expect(page.getByTestId("cfg-name-input")).toHaveValue(A1, { timeout: 10_000 });
    await expect(cfg.locator("label", { hasText: "简介" }).locator("input")).toHaveValue("E2E 矩阵简介");
    await expect(page.getByTestId("kw-chip-矩阵词")).toBeVisible();
    await page.getByTestId("tab-partners").click();
    await expect(page.getByTestId("partner-check-dev")).toBeChecked();
    await cfg.getByRole("button", { name: "取消" }).click();
  });

  test("4 左键智能体 → 新建会话页预选 → 发消息 → pill 为该智能体", async ({ page }) => {
    await expect(page.getByTestId(`agent-${A1}`)).toBeVisible({ timeout: 10_000 });
    await page.getByTestId(`agent-${A1}`).click();
    await expect(page.getByTestId("new-session-pane")).toBeVisible();
    await expect(page.getByTestId("agent-select")).toHaveValue(A1);

    await page.getByTestId("project-select").selectOption(projectId);
    // 必须先选模型，否则发送前置条件拦截
    await page.getByTestId("model-selector").selectOption({ label: "E2E/model-a" });
    const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');
    await textbox.click();
    await page.keyboard.type("矩阵链路消息", { delay: 5 });
    await page.getByTestId("composer-send").click();

    await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 10_000 });
    // 从侧栏会话行解析 sessionId（aside 内排除 session-view 等 testid 前缀干扰）
    const testid = await page.locator('aside [data-testid^="session-"]').first().getAttribute("data-testid");
    sessionId = testid?.replace("session-", "") ?? "";
    expect(sessionId).not.toBe("");
    // 顶部 pill 为所选智能体（displayName = name）
    await expect(page.getByTestId("agent-switcher")).toContainText(A1);
    // 假 provider 无 assistant 回复属预期，不断言回复内容
  });

  test("5 会话中切换：pill 下拉搜索 → 确认【继续切换】→「已切换为」分隔行", async ({ page }) => {
    await page.getByTestId(`session-${sessionId}`).click();
    await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("agent-switcher")).toContainText(A1);

    await page.getByTestId("agent-switcher").click();
    await page.getByTestId("switcher-search").fill("a2");
    await page.getByTestId(`switcher-item-${A2}`).click();
    await expect(page.getByTestId("switcher-confirm")).toBeVisible();
    await page.getByTestId("switcher-confirm-ok").click();

    // session:updated 到达后：pill 更新 + 消息流追加分隔行（custom 消息仅前端展示）
    await expect(page.getByTestId("agent-switcher")).toContainText(A2, { timeout: 10_000 });
    await expect(page.getByText(`已切换为 ${A2}`)).toBeVisible({ timeout: 10_000 });
  });

  test("6 Composer：@ 出智能体补全、# 出文件补全", async ({ page }) => {
    // # 文件搜索扫描项目 cwd 真实文件系统，预置目标文件（隔离目录内，teardown 统一清理）
    mkdirSync(projectCwd, { recursive: true });
    writeFileSync(join(projectCwd, "matrix-file.txt"), "agent matrix e2e", "utf8");

    await expect(page.getByTestId("new-session-pane")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("project-select").selectOption(projectId);
    const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');
    const menu = page.getByTestId("quick-invoke-menu");

    // @ 智能体补全：输入触发符出菜单，过滤后 Enter 选中 → chip 插入 + agent-select 联动
    await textbox.click();
    await page.keyboard.type("@", { delay: 10 });
    await expect(menu).toBeVisible({ timeout: 5_000 });
    await expect(menu).toContainText(A1);
    await page.keyboard.type(A3, { delay: 10 });
    await expect(menu).toContainText(A3);
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-testid="composer-input"] .chip-agent').first()).toBeVisible({ timeout: 3_000 });
    await expect(page.getByTestId("agent-select")).toHaveValue(A3);

    // 清空输入框（contenteditable 半受控：清 DOM + 发 input 事件同步 React state）
    await textbox.evaluate(el => {
      el.innerHTML = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // # 文件补全：预置文件出现在菜单
    await textbox.click();
    await page.keyboard.type("#matrix", { delay: 10 });
    await expect(menu).toBeVisible({ timeout: 5_000 });
    await expect(menu).toContainText("matrix-file.txt", { timeout: 10_000 });
    await page.keyboard.press("Escape");
  });

  test("7 删除智能体：二次确认 → 列表消失；会话保留 → agent_missing 重选恢复", async ({ page }) => {
    try {
      await page.getByTestId(`session-${sessionId}`).click();
      await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId("agent-switcher")).toContainText(A2);

      // 侧栏右键删除 A2（A2 名下有会话，按 recency 排第一，必定在侧栏前 3）
      await page.getByTestId(`agent-${A2}`).click({ button: "right" });
      await page.getByTestId("agent-ctx-delete").click();
      // agent-delete-confirm 包装 div 的子元素是 fixed 定位 Modal，自身塌缩 0 尺寸会被判 hidden，
      // 故断言内部 ConfirmDialog 本体（confirm-dialog 即删除二次确认框）
      await expect(page.getByTestId("confirm-dialog")).toBeVisible();
      await page.getByTestId("confirm-ok").click();
      await expect(page.getByTestId(`agent-${A2}`)).toHaveCount(0, { timeout: 10_000 });

      // 会话保留，pill 变 missing 警示
      await expect(page.getByTestId(`session-${sessionId}`)).toBeVisible();
      await expect(page.getByTestId("switcher-missing")).toBeVisible({ timeout: 10_000 });

      // 发消息 → kernel 回 agent_missing → 重选弹窗
      await page.getByTestId("model-selector").selectOption({ label: "E2E/model-a" });
      const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');
      await textbox.click();
      await page.keyboard.type("触发重选", { delay: 5 });
      await page.getByTestId("composer-send").click();
      await expect(page.getByTestId("agent-missing-modal")).toBeVisible({ timeout: 10_000 });

      // 点选 dev 恢复：弹窗关闭、pill 变为研发（global-setup 预置 dev.md 的 displayName）
      await page.getByTestId("agent-missing-item-dev").click();
      await expect(page.getByTestId("agent-missing-modal")).toHaveCount(0);
      await expect(page.getByTestId("agent-switcher")).toContainText("研发", { timeout: 10_000 });
      await expect(page.getByText("已切换为 dev")).toBeVisible({ timeout: 10_000 });
    } finally {
      // A2 已经 UI 删除；清理 A1 / A3（A3 名下无会话，互不影响）
      await deleteAgentQuiet(A1);
      await deleteAgentQuiet(A3);
    }
  });
});
