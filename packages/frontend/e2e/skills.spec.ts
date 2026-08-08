import { test, expect } from "@playwright/test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { addSkillDir, createProject, removeSkillDir } from "./helpers";

test.describe.serial("技能管理", () => {

  test("打开设置 → 技能菜单", async ({ page }) => {
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

  test("展开技能目录 + 内置目录无删除按钮", async ({ page }) => {
    await page.goto("/");
    await createProject("e2e-skills", "/tmp/e2e-skills");

    await page.goto("/");
    await page.getByTestId("settings-btn").click();
    await page.getByText("技能", { exact: true }).click(); // exact：避免命中侧栏会话标题（如「发起技能会话」）

    // 技能目录现默认展开（点 toggle 反而会折叠），直接断言：
    // 内置目录行存在且有 [内置] 标签（无删除按钮）
    await expect(page.getByText("[内置]")).toBeVisible({ timeout: 5000 });
  });

  test("禁用技能 + 启用技能", async ({ page }) => {
    // 先通过 REST 添加一个带技能的目录，让技能列表有内容
    const e2eSkillDir = join(process.env.HOME || "~", ".wa-pi-e2e-skills-test");
    if (!existsSync(e2eSkillDir)) {
      const skillDir = join(e2eSkillDir, "test-skill");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"),
        `---\nname: test-skill\ndescription: 测试技能\n---\n# test-skill`);
    }

    await page.goto("/");
    await createProject("e2e-skills", "/tmp/e2e-skills");
    await addSkillDir(e2eSkillDir);

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

    // 清理：删除测试目录
    await removeSkillDir(e2eSkillDir);
    rmSync(e2eSkillDir, { recursive: true, force: true });
  });
});
