import { test, expect } from "@playwright/test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { E2E_WA_PI_DIR } from "../playwright.config";
import { addSkillDir, createProject, getBuiltinSkill, removeSkillDir, ensureProvider, setUiPrefs } from "./helpers";

test.describe.serial("技能管理", () => {
  test.beforeAll(async () => {
    // 无 provider 时首启会弹 onboarding 向导（modal-overlay 遮挡点击，冷内核单独跑必挂）
    await ensureProvider();
  });

  test("打开设置 → 技能菜单", async ({ page }) => {
    // 断言中文界面（headless 默认 navigator=en-US 会渲染英文）
    await setUiPrefs(page, "zh");
    await page.goto("/");
    // 预置项目（复用 app-flow 模式）
    await createProject("e2e-skills", "/tmp/e2e-skills");

    await page.goto("/");
    await page.getByTestId("settings-btn").click();
    await expect(page.getByTestId("settings-modal")).toBeVisible();
    // 切到技能菜单
    await page.getByText("技能", { exact: true }).click(); // exact：避免命中侧栏会话标题（如「发起技能会话」）
    await expect(page.getByTestId("skill-dir-toggle")).toBeVisible();
    // 技能列表区已渲染（UI 已改为分组 + 搜索框形态，原「已加载技能」标题不存在）
    await expect(page.getByTestId("skill-search-input")).toBeVisible();
  });

  test("展开技能目录：目录区标签为 [全局] 且无删除按钮", async ({ page }) => {
    await setUiPrefs(page, "zh");
    await page.goto("/");
    await createProject("e2e-skills", "/tmp/e2e-skills");

    await page.goto("/");
    await page.getByTestId("settings-btn").click();
    await page.getByText("技能", { exact: true }).click(); // exact：避免命中侧栏会话标题（如「发起技能会话」）

    // 技能目录现默认展开（点 toggle 反而会折叠），直接断言：
    // 内置目录行存在且范围标签为 [全局]（改造后由原 [内置] 更名），目录区不再有删除按钮
    await expect(page.getByText("[全局]")).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-testid^="skill-dir-remove-"]')).toHaveCount(0);
  });

  test("禁用技能 + 启用技能", async ({ page }) => {
    // 直接向 E2E 隔离的内置技能目录注入技能（技能目录增删接口已下线，
    // helper 改为写 <WA_PI_DIR>/skills/test-skill 并轮询等 kernel 扫到）
    await addSkillDir("test-skill", "测试技能");

    await setUiPrefs(page, "zh");
    await page.goto("/");
    await createProject("e2e-skills", "/tmp/e2e-skills");

    await page.goto("/");
    await page.getByTestId("settings-btn").click();
    await page.getByText("技能", { exact: true }).click(); // exact：避免命中侧栏会话标题（如「发起技能会话」）

    // 等待技能出现
    await expect(page.getByText("test-skill")).toBeVisible({ timeout: 5000 });

    // 禁用（禁用标签现渲染在技能行内，文案无方括号）
    const skillRow = page.getByTestId("skill-row-test-skill");
    await page.getByTestId("skill-switch-test-skill").click();
    await expect(skillRow.getByText("禁用")).toBeVisible({ timeout: 5000 });

    // 启用
    await page.getByTestId("skill-switch-test-skill").click();
    await expect(skillRow.getByText("禁用")).toHaveCount(0, { timeout: 5000 });

    // 清理：移除注入的技能
    await removeSkillDir("test-skill");
  });
});

// 技能范围筛选：项目级技能（<project.cwd>/.pi/skills）的可见性与来源标签。
// 项目根全部落在 E2E 隔离目录内，不污染真实 HOME。
test.describe.serial("技能范围：项目级技能", () => {
  const PROJ_A_CWD = join(E2E_WA_PI_DIR, "e2e-scope-proj-a");
  const PROJ_B_CWD = join(E2E_WA_PI_DIR, "e2e-scope-proj-b");
  const SKILL_NAME = "e2e-scope-skill";
  const SKILL_DIR = join(PROJ_A_CWD, ".pi", "skills", SKILL_NAME);

  test.beforeAll(async () => {
    await ensureProvider();
    mkdirSync(SKILL_DIR, { recursive: true });
    writeFileSync(
      join(SKILL_DIR, "SKILL.md"),
      `---\nname: ${SKILL_NAME}\ndescription: 项目级范围测试技能\n---\n# ${SKILL_NAME}`,
      "utf8",
    );
    mkdirSync(PROJ_B_CWD, { recursive: true });
  });

  test.afterAll(async () => {
    rmSync(join(PROJ_A_CWD, ".pi"), { recursive: true, force: true });
    rmSync(join(PROJ_B_CWD, ".pi"), { recursive: true, force: true });
  });

  test("切到项目范围后项目技能出现且标签正确，切到无该目录的项目则消失", async ({ page }) => {
    const projA = await createProject("e2e-scope-A", PROJ_A_CWD);
    const projB = await createProject("e2e-scope-B", PROJ_B_CWD);
    await setUiPrefs(page, "zh");
    await page.goto("/");
    await page.getByTestId("settings-btn").click();
    await page.getByText("技能", { exact: true }).click();

    await page.getByTestId("skill-scope-select").click();
    await page.getByTestId(`skill-scope-option-project-${projA.id}`).click();
    const row = page.getByTestId(`skill-row-${SKILL_NAME}`);
    await expect(row).toBeVisible({ timeout: 5000 });
    await expect(row.getByText(`项目 skill（e2e-scope-A）`)).toBeVisible();

    await page.getByTestId("skill-scope-select").click();
    await page.getByTestId(`skill-scope-option-project-${projB.id}`).click();
    await expect(page.getByTestId(`skill-row-${SKILL_NAME}`)).toHaveCount(0);
  });

  test("同名时项目那条生效，全部范围只显示一行", async ({ page }) => {
    const projA = await createProject("e2e-scope-A", PROJ_A_CWD);
    await setUiPrefs(page, "zh");
    await addSkillDir(SKILL_NAME, "内置同名版本");
    try {
      // 先显式确认前提：内置同名条目已进入 allSkills（addSkillDir 的等待已收紧到 builtin
      // 来源，这里再直查一次做独立证据）；否则「项目那条生效」的优先级断言会失去对照面
      expect(
        await getBuiltinSkill(SKILL_NAME),
        `内置来源的 ${SKILL_NAME} 应已进入 allSkills`,
      ).toBeTruthy();
      await page.goto("/");
      await page.getByTestId("settings-btn").click();
      await page.getByText("技能", { exact: true }).click();
      await page.getByTestId("skill-scope-select").click();
      await page.getByTestId("skill-scope-option-all").click();
      const rows = page.getByTestId(`skill-row-${SKILL_NAME}`);
      await expect(rows).toHaveCount(1);
      await expect(rows.getByText(`项目 skill（e2e-scope-A）`)).toBeVisible();
    } finally {
      await removeSkillDir(SKILL_NAME).catch(() => {});
    }
  });
});
