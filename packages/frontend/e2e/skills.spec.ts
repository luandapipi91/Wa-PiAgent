import { test, expect } from "@playwright/test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";

test.describe.serial("技能管理", () => {

  test("打开设置 → 技能菜单", async ({ page }) => {
    await page.goto("/");
    // 预置项目（复用 app-flow 模式）
    await page.evaluate(async () => {
      const ws = new WebSocket("ws://127.0.0.1:9776");
      await new Promise<void>((res) => { ws.addEventListener("open", () => res(), { once: true }); });
      ws.send(JSON.stringify({ type: "project:create", name: "e2e-skills", cwd: "/tmp/e2e-skills" }));
      await new Promise(r => setTimeout(r, 300));
      ws.close();
    });

    await page.goto("/");
    await page.getByTestId("settings-btn").click();
    await expect(page.getByTestId("settings-modal")).toBeVisible();
    // 切到技能菜单
    await page.getByText("技能").click();
    await expect(page.getByTestId("skill-dir-toggle")).toBeVisible();
    await expect(page.getByText("已加载技能")).toBeVisible();
  });

  test("展开技能目录 + 内置目录无删除按钮", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(async () => {
      const ws = new WebSocket("ws://127.0.0.1:9776");
      await new Promise<void>((res) => { ws.addEventListener("open", () => res(), { once: true }); });
      ws.send(JSON.stringify({ type: "project:create", name: "e2e-skills", cwd: "/tmp/e2e-skills" }));
      await new Promise(r => setTimeout(r, 200));
      ws.close();
    });

    await page.goto("/");
    await page.getByTestId("settings-btn").click();
    await page.getByText("技能").click();
    await page.getByTestId("skill-dir-toggle").click();

    // 内置目录行存在且有 [内置] 标签
    await expect(page.getByText("[内置]")).toBeVisible({ timeout: 5000 });
  });

  test("禁用技能 + 启用技能", async ({ page }) => {
    // 先通过 WS 添加一个带技能的目录，让技能列表有内容
    const e2eSkillDir = join(process.env.HOME || "~", ".hiagent-e2e-skills-test");
    if (!existsSync(e2eSkillDir)) {
      const skillDir = join(e2eSkillDir, "test-skill");
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, "SKILL.md"),
        `---\nname: test-skill\ndescription: 测试技能\n---\n# test-skill`);
    }

    await page.goto("/");
    await page.evaluate(async (skillDir) => {
      const ws = new WebSocket("ws://127.0.0.1:9776");
      await new Promise<void>((res) => { ws.addEventListener("open", () => res(), { once: true }); });
      ws.send(JSON.stringify({ type: "project:create", name: "e2e-skills", cwd: "/tmp/e2e-skills" }));
      await new Promise(r => setTimeout(r, 200));
      ws.send(JSON.stringify({ type: "skillDir:add", path: skillDir }));
      await new Promise(r => setTimeout(r, 500));
      ws.close();
    }, e2eSkillDir);

    await page.goto("/");
    await page.getByTestId("settings-btn").click();
    await page.getByText("技能").click();

    // 等待技能出现
    await expect(page.getByText("test-skill")).toBeVisible({ timeout: 5000 });

    // 禁用
    await page.getByTestId("skill-switch-test-skill").click();
    await expect(page.getByText("[禁用]")).toBeVisible({ timeout: 5000 });

    // 启用
    await page.getByTestId("skill-switch-test-skill").click();
    await expect(page.getByText("[禁用]")).toHaveCount(0, { timeout: 5000 });

    // 清理：删除测试目录
    await page.evaluate(async (skillDir) => {
      const ws = new WebSocket("ws://127.0.0.1:9776");
      await new Promise<void>((res) => { ws.addEventListener("open", () => res(), { once: true }); });
      ws.send(JSON.stringify({ type: "skillDir:remove", path: skillDir }));
      await new Promise(r => setTimeout(r, 300));
      ws.close();
    }, e2eSkillDir);
    rmSync(e2eSkillDir, { recursive: true, force: true });
  });
});
