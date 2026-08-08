import { test, expect } from "@playwright/test";
import {
  createProject,
  deleteAgentQuiet,
  deleteAllProviders,
  getAgentConfig,
  saveProvider,
} from "./helpers";

// Task 12: 初始化向导 E2E
//
// 覆盖：
// 1. providers 为空 → 向导自动弹出 → 跳过模型配置 → 预设创建智能体 → 设为默认（新建会话页选中）
// 2. 有 provider 时不自动弹 → 设置页「重新打开引导」手动重开
//
// 环境说明：
// - global-setup 以隔离 WA_PI_DIR + WA_PI_SKIP_AGENT_SEED=1 起 kernel，初始无 providers、
//   仅预置 dev（研发）智能体；但共享 kernel 的其他 spec 可能写过 provider，
//   故 beforeAll 先 deleteAllProviders() 保证「无模型」前提。
// - 自动弹出判定走 providers.loaded 标志（load() 返回合法数组才置 true），无 loading 中间态断言。
// - testid 以组件实际为准：设置按钮是 settings-btn、新建会话页智能体 pill 是 agent-select
//   （AgentDropdown 默认 pillTestId）；向导/选择器 testid 见 OnboardingWizard/AgentCreatePicker。
// - 「默认选中」断言必须 reload：NewSessionPane 仅在挂载/agentName 为 null 时按
//   pickDefaultAgent 回填，向导设置 defaultAgent（localStorage 持久化）时已挂载的实例不会重选。

const AGENT_NAME = "E2E向导智能体";
const PRESET_ID = "engineering-code-reviewer"; // 代码审查员

test.describe.serial("初始化向导", () => {
  test.beforeAll(async () => {
    await deleteAllProviders(); // 确保 providers 为空 → 向导自动弹出
    await deleteAgentQuiet(AGENT_NAME);
  });

  test.afterAll(async () => {
    // 还原环境：删掉测试智能体 + 清空 providers（用例 2 补的假 provider 不留给后续 spec）
    await deleteAgentQuiet(AGENT_NAME);
    await deleteAllProviders();
  });

  test("无模型时自动弹出 → 跳过模型 → 从预设创建 → 新建会话默认选中", async ({ page }) => {
    await createProject("e2e-onboarding", "/tmp/e2e-onboarding");
    await page.goto("/");

    // 1. 向导自动弹出（providers 为空），第 1 步是模型配置
    await expect(page.getByTestId("onboarding-wizard")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("wizard-step-1")).toBeVisible();

    // 2. 不保存模型，直接下一步 → 第 2 步设置默认智能体（默认已在预设 Tab）
    await page.getByTestId("wizard-next").click();
    await expect(page.getByTestId("wizard-step-2")).toBeVisible();

    // 3. 搜索预设 → 选中卡片 → 命名面板
    await page.getByTestId("preset-search-input").fill("代码审查");
    await page.getByTestId(`preset-card-${PRESET_ID}`).click();
    await expect(page.getByTestId("preset-name-input")).toBeVisible();

    // 4. 改成固定名并保存 → 向导关闭，智能体已创建并设为默认
    await page.getByTestId("preset-name-input").fill(AGENT_NAME);
    await page.getByTestId("preset-save-btn").click();
    await expect(page.getByTestId("onboarding-wizard")).toHaveCount(0, { timeout: 10_000 });

    // 5. API 断言：agent.md 正文注入了名字（preset-store 的 buildAgentConfigFromPreset 契约）
    const cfg = await getAgentConfig(AGENT_NAME);
    expect(cfg.systemPromptBody).toContain(`你的名字是「${AGENT_NAME}」。`);

    // 6. 新建会话页默认选中该智能体（reload 让 NewSessionPane 以最新 defaultAgent 重新挂载，
    //    见文件头说明；localStorage 持久化保证 reload 后 defaultAgent 仍在）
    await page.reload();
    await expect(page.getByTestId("new-session-pane")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("agent-select")).toContainText(AGENT_NAME, { timeout: 10_000 });
  });

  test("设置页可重新打开引导", async ({ page }) => {
    await createProject("e2e-onboarding2", "/tmp/e2e-onboarding2");
    // 先补一个 provider：providers 非空 → 向导不应自动弹出
    await saveProvider({
      id: "e2e-onboarding-provider",
      name: "E2E Onboarding",
      baseUrl: "http://localhost:9999/v1",
      apiKey: "sk-e2e",
      api: "openai-completions",
      models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
    });

    await page.goto("/");
    // 等页面就绪（智能体 pill 出现说明首屏加载完成），再断言向导未自动弹出
    await expect(page.getByTestId("new-session-pane")).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(1500); // 给 providers load → 自动弹出判定留窗口
    await expect(page.getByTestId("onboarding-wizard")).toHaveCount(0);

    // 设置 → 通用（默认页签）→ 重新打开引导
    await page.getByTestId("settings-btn").click();
    await expect(page.getByTestId("settings-modal")).toBeVisible();
    await page.getByTestId("reopen-onboarding").click();

    // 设置弹窗关闭、向导重开在第 1 步
    await expect(page.getByTestId("settings-modal")).toHaveCount(0);
    await expect(page.getByTestId("onboarding-wizard")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("wizard-step-1")).toBeVisible();

    // 关闭向导（ESC），provider 清理由 afterAll 的 deleteAllProviders 统一还愿
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("onboarding-wizard")).toHaveCount(0);
  });
});
