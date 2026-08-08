import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { E2E_WA_PI_DIR } from "../playwright.config";
import {
  createAgent,
  createProject,
  deleteAgentQuiet,
  getAgentConfig,
  saveAgentConfig,
  saveProvider,
  addSkillDir,
  removeSkillDir,
} from "./helpers";

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
// - global-setup 在 kernel 启动前预置了 agents/dev.md，并以 WA_PI_SKIP_AGENT_SEED=1 启动 kernel，
//   隔离环境初始只有 1 个智能体（dev），不会 seed 11 个内置角色。
// - 因此场景 1 的「第 4 个智能体」经 REST POST /api/agents 补数据（UI 新建入口此时不可达：
//   侧栏空态新建仅 0 个智能体时出现，宫格入口 agent-more 要 >3 个才显示，存在先有鸡先有蛋问题）；
//   UI 新建路径在场景 2 经宫格 gallery-create 完整覆盖。
// - 假 provider（localhost:9999）无法产出 assistant 回复：相关断言只落在不依赖模型回复的 UI 状态
//   （pill / 分隔行 / 弹窗），发送失败产生的错误消息不影响断言。
//
// 清理：每个 test 创建的智能体在 finally 中经 REST DELETE /api/agents/:name 删除（幂等，忽略报错）；
// 测试文件写在隔离 WA_PI_DIR 内，global-teardown 统一删除。

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
      projectCwd = join(E2E_WA_PI_DIR, "agents-e2e-proj");
      // 项目目录必须先存在：pi 子进程以 cwd 启动，目录缺失会 spawn ENOENT，
      // 表现为会话启动失败、session:set-agent 切换无响应
      mkdirSync(projectCwd, { recursive: true });
      const project = await createProject(
        `e2e-agents-${randomUUID().slice(0, 8)}`,
        projectCwd,
      );
      projectId = project.id;
      await saveProvider({
        id: "e2e-agents-provider",
        name: "E2E",
        baseUrl: "http://localhost:9999/v1",
        apiKey: "sk-e2e",
        api: "openai-completions",
        models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
      });
    }
    await page.goto("/", { timeout: 60_000 });
  });

  test.afterAll(async () => {
    // 安全网：finally 未执行到时兜底清理（隔离目录每次 run 重建，主要防用例间污染）
    for (const name of [A1, A2, A3, UI_AGENT]) await deleteAgentQuiet(name);
  });

  test("1 侧边栏默认 ≤3 个智能体，第 4 个出现后有「更多智能体」入口", async ({ page }) => {
    // 初始仅 dev（global-setup 预置，displayName=研发），无更多入口
    await expect(page.getByTestId("agent-研发")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("agent-more")).toHaveCount(0);

    // 经 REST 补足到 4 个（UI 新建入口此时不可达，见文件头说明）；广播 agent:list 驱动侧栏刷新
    await createAgent(A1);
    await createAgent(A2);
    await createAgent(A3);

    // 侧栏只展示前 3 个（无会话时按名称 locale 排序：e2e-a1/a2/a3 在前，中文「研发」排最后进「更多智能体」）
    await expect(page.getByTestId(`agent-${A1}`)).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId(`agent-${A2}`)).toBeVisible();
    await expect(page.getByTestId(`agent-${A3}`)).toBeVisible();
    await expect(page.getByTestId("agent-more")).toBeVisible();
    await expect(page.getByTestId("agent-more")).toContainText("(1)");
  });

  test("2 宫格弹窗：打开 → 卡片 → UI 新建 → 右键编辑进详情弹窗", async ({ page }) => {
    try {
      await page.getByTestId("agent-more").click();
      await expect(page.getByTestId("agent-gallery")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId("gallery-card-研发")).toBeVisible();
      await expect(page.getByTestId(`gallery-card-${A1}`)).toBeVisible();

      // 宫格内 UI 新建：AgentCreatePicker（默认预设 Tab，切空白创建）；
      // 确定后按乐观打开契约直接进入详情弹窗
      await page.getByTestId("gallery-create").click();
      await page.getByTestId("picker-tab-blank").click();
      await page.getByTestId("blank-name-input").fill(UI_AGENT);
      await page.getByTestId("blank-create-btn").click();
      await expect(page.getByTestId("agent-config")).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId("cfg-name-input")).toHaveValue(UI_AGENT, { timeout: 10_000 });
      await page.getByTestId("agent-config").getByRole("button", { name: "关闭" }).click();

      // 新建契约是「宫格保持打开，编辑弹窗叠加」（App.tsx onCreated 不关列表），
      // 关闭编辑弹窗后宫格仍在，直接断言新卡片出现（不能再点 agent-more，会被宫格 overlay 拦截）
      await expect(page.getByTestId(`gallery-card-${UI_AGENT}`)).toBeVisible({ timeout: 10_000 });

      // 右键卡片 →【编辑智能体】→ 详情弹窗
      await page.getByTestId(`gallery-card-${A1}`).click({ button: "right" });
      await page.getByTestId("gallery-ctx-edit").click();
      await expect(page.getByTestId("agent-config")).toBeVisible();
      await expect(page.getByTestId("cfg-name-input")).toHaveValue(A1, { timeout: 10_000 });
      await page.getByTestId("agent-config").getByRole("button", { name: "关闭" }).click();
    } finally {
      await deleteAgentQuiet(UI_AGENT);
    }
  });

  test("3 详情弹窗：改简介 + 关系网 + 保存 → 宫格卡片简介更新", async ({ page }) => {
    const cfg = page.getByTestId("agent-config");
    await page.getByTestId("agent-more").click();
    await page.getByTestId(`gallery-card-${A1}`).click({ button: "right" });
    await page.getByTestId("gallery-ctx-edit").click();
    await expect(cfg).toBeVisible();
    await expect(page.getByTestId("cfg-name-input")).toHaveValue(A1, { timeout: 10_000 });

    // 基本：改简介
    await cfg.locator("label", { hasText: "简介" }).locator("input").fill("E2E 矩阵简介");

    // 关系网：勾选 dev（自身不可勾：SwitchButton 对 self 点击 no-op）
    // （UI 已从 checkbox partner-check-* 改为开关 partner-switch-*，用 data-on 断言开关态）
    await page.getByTestId("tab-partners").click();
    await expect(page.getByTestId("partner-search")).toBeVisible();
    await page.getByTestId("partner-switch-研发").click();
    await expect(page.getByTestId("partner-switch-研发")).toHaveAttribute("data-on", "true");
    // 自身开关点击无效，保持关
    await page.getByTestId(`partner-switch-${A1}`).click();
    await expect(page.getByTestId(`partner-switch-${A1}`)).toHaveAttribute("data-on", "false");

    await cfg.getByRole("button", { name: "保存" }).click();
    await expect(cfg).toHaveCount(0);

    // config:save 保存后 kernel 广播 agent:list（含非改名路径），store 实时刷新：
    // 不 reload；编辑弹窗是叠加在宫格上的（App.tsx onEdit 列表保持打开），
    // 关闭编辑弹窗后宫格仍在，直接断言卡片简介已变为新值（不能再点 agent-more，会被宫格 overlay 拦截）
    await expect(page.getByTestId(`gallery-card-${A1}`)).toContainText("E2E 矩阵简介", { timeout: 10_000 });

    // 重开详情弹窗验证保存已持久化到 kernel（agent:config:get 重取文件）
    await page.getByTestId(`gallery-card-${A1}`).click({ button: "right" });
    await page.getByTestId("gallery-ctx-edit").click();
    await expect(page.getByTestId("cfg-name-input")).toHaveValue(A1, { timeout: 10_000 });
    await expect(cfg.locator("label", { hasText: "简介" }).locator("input")).toHaveValue("E2E 矩阵简介");
    await page.getByTestId("tab-partners").click();
    await expect(page.getByTestId("partner-switch-研发")).toHaveAttribute("data-on", "true");
    await cfg.getByRole("button", { name: "关闭" }).click();
  });

  test("4 左键智能体 → 新建会话页预选 → 发消息 → pill 为该智能体", async ({ page }) => {
    await expect(page.getByTestId(`agent-${A1}`)).toBeVisible({ timeout: 10_000 });
    await page.getByTestId(`agent-${A1}`).click();
    await expect(page.getByTestId("new-session-pane")).toBeVisible();
    await expect(page.getByTestId("agent-select")).toContainText(A1);

    await page.getByTestId("project-select").selectOption(projectId);
    // 必须先选模型，否则发送前置条件拦截
    await page.getByTestId("model-selector").selectOption({ label: "E2E/model-a" });
    const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');
    await textbox.click();
    await page.keyboard.type("矩阵链路消息", { delay: 5 });
    await page.getByTestId("composer-send").click();

    await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 10_000 });
    // 从侧栏会话行解析 sessionId：必须按标题定位——kernel 的 getCommands 兜底会为
    // NewSessionPane 的随机 sessionId 预建空标题会话（agent=默认研发），aside 首行不一定是本会话
    const testid = await page.locator('aside [data-testid^="session-"]:has-text("矩阵链路消息")').first().getAttribute("data-testid");
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

    // @ 菜单只列当前主智能体 partners.askTo 名单内的命名智能体（a003ae7 起的行为），
    // 先把 A1 的 askTo 设为 [A3]，再在新建会话页把主智能体选为 A1
    const cfg = await getAgentConfig(A1);
    await saveAgentConfig(A1, { ...cfg, partners: { askTo: [A3] } });

    await expect(page.getByTestId("new-session-pane")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("project-select").selectOption(projectId);
    await page.getByTestId("agent-select").click();
    await page.getByTestId(`agent-item-${A1}`).click();
    const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');
    const menu = page.getByTestId("quick-invoke-menu");

    // @ 智能体补全：输入触发符出菜单（A1 的 askTo 内只有 A3），Enter 选中 → chip 插入
    // （@[xxx] 以 token 形式保留给主智能体委派，不再联动切换 agent-select）
    await textbox.click();
    await page.keyboard.type("@", { delay: 10 });
    await expect(menu).toBeVisible({ timeout: 5_000 });
    await expect(menu).toContainText(A3);
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-testid="composer-input"] .chip-agent').first()).toBeVisible({ timeout: 3_000 });

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
      await page.getByTestId("agent-missing-item-研发").click();
      await expect(page.getByTestId("agent-missing-modal")).toHaveCount(0);
      await expect(page.getByTestId("agent-switcher")).toContainText("研发", { timeout: 10_000 });
      await expect(page.getByText("已切换为 研发")).toBeVisible({ timeout: 10_000 });
    } finally {
      // A2 已经 UI 删除；清理 A1 / A3（A3 名下无会话，互不影响）
      await deleteAgentQuiet(A1);
      await deleteAgentQuiet(A3);
    }
  });
});

// 编辑智能体 - 技能 tab：全部勾选开关（支持全不选）+ 技能名不换行 + 描述点击气泡
// 独立 describe：自包含地注入测试技能目录 + 凑齐宫格入口所需智能体，不依赖上方串行状态
test.describe.serial("技能 tab：全部勾选开关与描述气泡", () => {
  const SK_AGENT = "e2e-skill-agent";
  const SK_FILLER1 = "e2e-skill-f1";
  const SK_FILLER2 = "e2e-skill-f2";
  const SK_FILLER3 = "e2e-skill-f3";
  // 测试技能目录（含一个长描述技能用于气泡验证）
  const e2eSkillDir = join(E2E_WA_PI_DIR, "e2e-skill-tab-skills");
  const longDesc = "这是一段很长的技能描述用于验证超长省略与点击气泡显示完整内容的功能，需要足够长才能触发省略号".repeat(2);

  test.beforeAll(async () => {
    // 注入测试技能目录
    const skillDir = join(e2eSkillDir, "e2e-skill-long");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: e2e-skill-long\ndescription: ${longDesc}\n---\n# e2e-skill-long`,
    );
    const skillDir2 = join(e2eSkillDir, "e2e-skill-short");
    mkdirSync(skillDir2, { recursive: true });
    writeFileSync(
      join(skillDir2, "SKILL.md"),
      `---\nname: e2e-skill-short\ndescription: 短技能\n---\n# e2e-skill-short`,
    );
    await addSkillDir(e2eSkillDir);
    // 凑齐宫格入口（agent-more 需 >3 个智能体）：dev(研发) + 目标 + 3 个 filler
    await createAgent(SK_AGENT);
    await createAgent(SK_FILLER1);
    await createAgent(SK_FILLER2);
    await createAgent(SK_FILLER3);
  });

  test.afterAll(async () => {
    // 清理测试技能目录与智能体
    await removeSkillDir(e2eSkillDir).catch(() => {});
    rmSync(e2eSkillDir, { recursive: true, force: true });
    for (const n of [SK_AGENT, SK_FILLER1, SK_FILLER2, SK_FILLER3])
      await deleteAgentQuiet(n);
  });

  test("全部勾选开关：默认 ON → 点击全不选 → 再次点击恢复全选；描述点击气泡", async ({ page }) => {
    await page.goto("/", { timeout: 60_000 });
    test.setTimeout(120_000);

    // 打开宫格 → 右键目标 agent → 编辑
    await page.getByTestId("agent-more").click();
    await page.getByTestId(`gallery-card-${SK_AGENT}`).click({ button: "right" });
    await page.getByTestId("gallery-ctx-edit").click();
    await expect(page.getByTestId("agent-config")).toBeVisible();
    await expect(page.getByTestId("cfg-name-input")).toHaveValue(SK_AGENT, { timeout: 10_000 });

    // 切到技能 tab
    await page.getByTestId("tab-skills").click();
    // 等待测试技能出现（store 异步加载）
    await expect(page.getByTestId("skill-switch-e2e-skill-long")).toBeVisible({ timeout: 10_000 });

    // 全部勾选开关默认 ON
    await expect(page.getByTestId("skill-select-all")).toHaveAttribute("data-on", "true");
    await expect(page.getByTestId("skill-switch-e2e-skill-long")).toHaveAttribute("data-on", "true");
    await expect(page.getByTestId("skill-switch-e2e-skill-short")).toHaveAttribute("data-on", "true");

    // 点击全部勾选开关 → 全不选
    await page.getByTestId("skill-select-all").click();
    await expect(page.getByTestId("skill-select-all")).toHaveAttribute("data-on", "false");
    await expect(page.getByTestId("skill-switch-e2e-skill-long")).toHaveAttribute("data-on", "false");
    await expect(page.getByTestId("skill-switch-e2e-skill-short")).toHaveAttribute("data-on", "false");

    // 保存 → 验证持久化 skillsAllOff: true（REST 读取配置，getAgentConfig 已返回 config 对象）
    // 用 cfg-save testid 而非按钮文案：本用例中途会 reload，headless Chromium navigator.language=en-US，
    // reload 后 detectInitialLanguage 读到 main.tsx 写入的持久化 "en" → 界面变英文，文案选择器会失配
    await page.getByTestId("cfg-save").click();
    await expect(page.getByTestId("agent-config")).toHaveCount(0);
    const cfgAfter = await getAgentConfig(SK_AGENT);
    expect(cfgAfter.skillsAllOff).toBe(true);

    // 重开验证：全不选态应持久化（开关 OFF）。刷新页面重置所有 modal 状态再重开
    await page.goto("/", { timeout: 60_000 });
    await page.getByTestId("agent-more").click();
    await page.getByTestId(`gallery-card-${SK_AGENT}`).click({ button: "right" });
    await page.getByTestId("gallery-ctx-edit").click();
    await expect(page.getByTestId("agent-config")).toBeVisible();
    await page.getByTestId("tab-skills").click();
    await expect(page.getByTestId("skill-switch-e2e-skill-long")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("skill-select-all")).toHaveAttribute("data-on", "false");
    await expect(page.getByTestId("skill-switch-e2e-skill-long")).toHaveAttribute("data-on", "false");

    // 描述气泡：点击超长描述 → 弹出完整描述 → 再次点击关闭
    await expect(page.getByTestId("skill-desc-bubble-e2e-skill-long")).toHaveCount(0);
    await page.getByTestId("skill-desc-e2e-skill-long").click();
    await expect(page.getByTestId("skill-desc-bubble-e2e-skill-long")).toBeVisible();
    await expect(page.getByTestId("skill-desc-bubble-e2e-skill-long")).toContainText(longDesc);
    await page.getByTestId("skill-desc-e2e-skill-long").click();
    await expect(page.getByTestId("skill-desc-bubble-e2e-skill-long")).toHaveCount(0);

    // 恢复全选并保存，避免污染其他用例（cfg-save：reload 后界面为英文，见上方说明）
    await page.getByTestId("skill-select-all").click();
    await expect(page.getByTestId("skill-select-all")).toHaveAttribute("data-on", "true");
    await page.getByTestId("cfg-save").click();
    await expect(page.getByTestId("agent-config")).toHaveCount(0);
  });
});
