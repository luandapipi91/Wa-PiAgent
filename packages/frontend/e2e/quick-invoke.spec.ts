import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { addSkillDir, createProject, saveProvider } from "./helpers";

// Task 8: Quick Invoke 聊天栏快速调用 E2E 测试
//
// 覆盖：
// 1. `#` 触发文件选择面板 → 选中 → chip 内联插入（绿色）→ 发送时展开为 `#相对路径`
// 2. `$` 触发技能选择面板 → 选中 → chip 内联插入（靛蓝）→ 发送时展开为 `/skill:技能名`（SDK _expandSkillCommand 识别）
// 3. Esc 关闭面板但保留触发符文本
// 4. Backspace 删除整个 chip
//
// 约定：
// - 复用 composer.spec.ts 的 beforeEach 隔离项目模式（REST 建项目 + 预置 provider）
// - 技能通过 globalSetup 注入的内置技能或 addSkillDir 动态添加的测试技能驱动
// - 输入框为 contenteditable div，selector 使用 [role="textbox']
// - 文件搜索依赖 projectCwd 下的真实文件 —— 测试在项目 cwd 下预置文件
// - 截图清理：所有测试产生的临时文件 / 目录在 finally / afterAll 中删除

test.describe.serial("Quick Invoke 聊天栏快速调用", () => {
  let projectId = "";
  let projectCwd = "";

  test.beforeEach(async () => {
    // 1. 创建隔离测试项目（带真实 cwd，便于 @ 文件搜索）
    const projectName = `e2e-quick-invoke-${randomUUID().slice(0, 8)}`;
    projectCwd = `/tmp/${projectName}`;
    const project = await createProject(projectName, projectCwd);
    projectId = project.id;

    // 2. 预置模型供应商，让 ModelSelector 有可选项
    await saveProvider({
      id: "e2e-quick-invoke-provider",
      name: "E2E",
      baseUrl: "http://localhost:9999/v1",
      apiKey: "sk-e2e",
      api: "openai-completions",
      models: [
        { id: "model-a", contextWindow: 128000, maxTokens: 4096 },
      ],
    });
  });

  // 进入 session 视图（仿 composer.spec.ts 的 enterSession）
  async function enterSession(page: import("@playwright/test").Page, text: string): Promise<string> {
    await page.goto("/");
    await expect(page.getByTestId("new-session-pane")).toBeVisible({ timeout: 5000 });
    // 必须选中 beforeEach 创建的项目：全局 seed 项目 e2e-proj-1 排在 projects[0]，
    // 不选的话新会话会挂到 seed 项目下，# 文件搜索会搜错目录
    await page.getByTestId("project-select").selectOption(projectId);
    await page.getByTestId("model-selector").selectOption({ label: "E2E/model-a" });
    const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');
    await textbox.click();
    await page.keyboard.type(text, { delay: 5 });
    await page.getByTestId("composer-send").click();
    await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 8000 });
    const testid = await page.locator('[data-testid^="session-"]').first().getAttribute("data-testid");
    return testid?.replace("session-", "") ?? "";
  }

  test("输入 # 选文件 → chip 显示 → 发送时展开", async ({ page }) => {
    // 在项目 cwd 预置一个可搜索的文件（searchFilesStream 扫描真实文件系统）
    mkdirSync(projectCwd, { recursive: true });
    const targetName = "hello-quick.txt";
    const targetPath = join(projectCwd, targetName);
    writeFileSync(targetPath, "hello quick invoke", "utf8");

    try {
      await enterSession(page, "发起会话");

      const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');

      // 1. 输入空格 + #（# 必须在行首或空格之后才触发）
      await textbox.click();
      await page.keyboard.type(" ", { delay: 5 });
      await page.keyboard.type("#", { delay: 5 });

      // 2. 等待 Quick Invoke 文件面板出现
      await expect(page.getByTestId("quick-invoke-menu")).toBeVisible({ timeout: 5000 });

      // 3. 输入文件名过滤，等待目标文件出现在列表
      await page.keyboard.type("hello", { delay: 10 });
      await expect(page.getByTestId("quick-invoke-menu")).toContainText(targetName, { timeout: 8000 });

      // 4. Enter 选中第一项
      await page.keyboard.press("Enter");

      // 5. 验证 chip 出现在输入框（绿色 chip-file，data-token 含 #[...]）
      await expect(page.locator('[data-testid="composer-input"] .chip-file').first()).toBeVisible({ timeout: 3000 });
      await expect(textbox).toContainText(targetName);

      // 6. 输入附加文本
      await page.keyboard.type(" 查看这个文件", { delay: 5 });

      // 7. 点击发送
      await page.getByTestId("composer-send").click();

      // 8. 发送后输入框清空
      await expect(textbox).toBeEmpty({ timeout: 3000 });

      // 9. 验证发送的消息中 chip 展开为 #hello-quick.txt 纯文本（无方括号）
      await expect(page.getByText(`#${targetName}`).first()).toBeVisible({ timeout: 8000 });
      // 不应出现原始 token 形式 #[...]
      await expect(page.locator(`text=#\\[${targetName}\\]`)).toHaveCount(0);
    } finally {
      if (existsSync(targetPath)) unlinkSync(targetPath);
    }
  });

  test("输入 $ 选技能 → chip 显示 → 发送时展开", async ({ page }) => {
    // 预置一个技能目录 + 测试技能（skillDir:add 触发 kernel 重扫，skill:changed 回推）
    const skillDirRoot = join(process.env.HOME || "/tmp", `.wa-pi-e2e-quick-invoke-skills-${randomUUID().slice(0, 8)}`);
    const skillPkgDir = join(skillDirRoot, "e2e-qi-skill");
    mkdirSync(skillPkgDir, { recursive: true });
    writeFileSync(
      join(skillPkgDir, "SKILL.md"),
      "---\nname: e2e-qi-skill\ndescription: E2E Quick Invoke 测试技能\n---\n# e2e-qi-skill\n测试用",
      "utf8",
    );

    try {
      // 通过 REST 把技能目录加到 kernel（POST 返回时重扫已完成，skill:changed 经 SSE 回推前端）
      await addSkillDir(skillDirRoot);

      await enterSession(page, "发起技能会话");

      const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');

      // 1. 输入 $（行首触发）
      await textbox.click();
      await page.keyboard.type("$", { delay: 5 });

      // 2. 等待技能面板出现
      await expect(page.getByTestId("quick-invoke-menu")).toBeVisible({ timeout: 5000 });

      // 3. 输入技能名过滤
      await page.keyboard.type("e2e-qi", { delay: 10 });
      await expect(page.getByTestId("quick-invoke-menu")).toContainText("e2e-qi-skill", { timeout: 8000 });

      // 4. Enter 选中
      await page.keyboard.press("Enter");

      // 5. 验证靛蓝 chip 出现
      await expect(page.locator('[data-testid="composer-input"] .chip-skill').first()).toBeVisible({ timeout: 3000 });

      // 6. 点击发送
      await page.getByTestId("composer-send").click();

      // 7. 验证发送的消息中 chip 展开为 /skill:e2e-qi-skill（expandTokens 的既定格式）
      await expect(page.getByText("/skill:e2e-qi-skill").first()).toBeVisible({ timeout: 8000 });
      await expect(page.locator(`text=\\$\\[e2e-qi-skill\\]`)).toHaveCount(0);
    } finally {
      if (existsSync(skillDirRoot)) rmSync(skillDirRoot, { recursive: true, force: true });
    }
  });

  test("输入全角 ￥（U+FFE5）触发技能面板", async ({ page }) => {
    // 预置技能（与 $ 用例相同的 setup：REST addSkillDir + SSE 回推）
    const skillDirRoot = join(process.env.HOME || "/tmp", `.wa-pi-e2e-quick-invoke-skills-${randomUUID().slice(0, 8)}`);
    const skillPkgDir = join(skillDirRoot, "e2e-qi-skill");
    mkdirSync(skillPkgDir, { recursive: true });
    writeFileSync(
      join(skillPkgDir, "SKILL.md"),
      "---\nname: e2e-qi-skill\ndescription: E2E Quick Invoke 测试技能\n---\n# e2e-qi-skill\n测试用",
      "utf8",
    );

    try {
      await addSkillDir(skillDirRoot);
      await enterSession(page, "发起技能会话");

      const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');

      // 1. 输入全角 ￥（Playwright 对 Unicode 字符走 insertText，模拟输入法插入 U+FFE5）
      await textbox.click();
      await page.keyboard.type("\uFFE5", { delay: 5 });

      // 2. 等待技能面板出现
      await expect(page.getByTestId("quick-invoke-menu")).toBeVisible({ timeout: 5000 });

      // 3. 输入技能名过滤并断言技能项出现
      await page.keyboard.type("e2e-qi", { delay: 10 });
      await expect(page.getByTestId("quick-invoke-menu")).toContainText("e2e-qi-skill", { timeout: 8000 });
    } finally {
      if (existsSync(skillDirRoot)) rmSync(skillDirRoot, { recursive: true, force: true });
    }
  });

  test("Esc 关闭面板保留触发符文本", async ({ page }) => {
    // 预置技能。注意：Esc 拦截的前提是 menuItems.length > 0（见 ComposerInput handleKeyDown），
    // 所以过滤词必须命中真实存在的技能——E2E 隔离环境无内置技能（brainstorming 等不在
    // 隔离 WA_PI_DIR 里），只能用这里动态添加的 e2e-esc-skill。
    const skillDirRoot = join(process.env.HOME || "/tmp", `.wa-pi-e2e-quick-invoke-esc-${randomUUID().slice(0, 8)}`);
    const skillPkgDir = join(skillDirRoot, "e2e-esc-skill");
    mkdirSync(skillPkgDir, { recursive: true });
    writeFileSync(
      join(skillPkgDir, "SKILL.md"),
      "---\nname: e2e-esc-skill\ndescription: Esc 测试\n---\n# e2e-esc-skill",
      "utf8",
    );

    try {
      // POST 返回时重扫已完成，skill:changed 经 SSE 回推前端，无 setTimeout 竞态
      await addSkillDir(skillDirRoot);

      await enterSession(page, "Esc 测试会话");

      const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');
      await textbox.click();
      await page.keyboard.type("$", { delay: 5 });
      await expect(page.getByTestId("quick-invoke-menu")).toBeVisible({ timeout: 5000 });

      // 输入查询并等待列表真的出现匹配项（保证 Esc 时 menuItems.length > 0）
      await page.keyboard.type("e2e-esc", { delay: 10 });
      await expect(page.getByTestId("quick-invoke-menu")).toContainText("e2e-esc-skill", { timeout: 8000 });

      // 按 Esc
      await page.keyboard.press("Escape");

      // 面板消失
      await expect(page.getByTestId("quick-invoke-menu")).toHaveCount(0, { timeout: 3000 });

      // 输入框保留 $e2e-esc 文本
      await expect(textbox).toContainText("$e2e-esc");
    } finally {
      if (existsSync(skillDirRoot)) rmSync(skillDirRoot, { recursive: true, force: true });
    }
  });

  test("菜单加宽 + 键盘上下导航自动滚动到高亮项", async ({ page }) => {
    // 预置 30 个文件，让列表超出菜单最大高度（320px），产生滚动条
    mkdirSync(projectCwd, { recursive: true });
    const filePaths: string[] = [];
    for (let i = 0; i < 30; i++) {
      const p = join(projectCwd, `qiscroll-${String(i).padStart(2, "0")}.txt`);
      writeFileSync(p, `scroll test ${i}`, "utf8");
      filePaths.push(p);
    }

    try {
      await enterSession(page, "滚动测试会话");

      const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');
      await textbox.click();
      await page.keyboard.type(" #qiscroll", { delay: 10 });

      const menu = page.getByTestId("quick-invoke-menu");
      await expect(menu).toBeVisible({ timeout: 5000 });

      // 菜单宽度已加宽（>= 540px）
      const box = await menu.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(540);

      // 等待全部 30 个结果到达（异步流式搜索，避免高亮被重置干扰）。
      // 全量跑时前面用例遗留的假 provider 会话（卡「运行中」）会拖慢 kernel 文件搜索，
      // 超时给足余量（单跑 ~3s 即可）
      await expect(page.getByTestId("quick-invoke-item-29")).toBeVisible({ timeout: 20000 });

      // 向下移动 20 次：高亮从第 0 项移到第 20 项（远超可视区域）
      for (let i = 0; i < 20; i++) {
        await page.keyboard.press("ArrowDown");
        await page.waitForTimeout(30);
      }

      // 断言：菜单已滚动，且高亮项完整处于可视区域内
      const result = await menu.evaluate((el) => {
        const items = el.querySelectorAll('[data-testid^="quick-invoke-item-"]');
        let highlighted: HTMLElement | null = null;
        items.forEach((it) => {
          if ((it as HTMLElement).className.includes("bg-accent-soft")) highlighted = it as HTMLElement;
        });
        if (!highlighted) return { scrollTop: el.scrollTop, visible: false, hasHighlight: false };
        const r = highlighted.getBoundingClientRect();
        const m = el.getBoundingClientRect();
        return {
          scrollTop: el.scrollTop,
          visible: r.top >= m.top && r.bottom <= m.bottom,
          hasHighlight: true,
        };
      });
      expect(result.hasHighlight).toBe(true);
      expect(result.scrollTop).toBeGreaterThan(0);
      expect(result.visible).toBe(true);
    } finally {
      for (const p of filePaths) {
        if (existsSync(p)) unlinkSync(p);
      }
    }
  });

  test("Backspace 删除整个 chip", async ({ page }) => {
    // 预置文件 + 技能
    mkdirSync(projectCwd, { recursive: true });
    const targetName = "bs-chip.txt";
    const targetPath = join(projectCwd, targetName);
    writeFileSync(targetPath, "backspace chip", "utf8");

    try {
      await enterSession(page, "Backspace 测试");

      const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');
      await textbox.click();
      await page.keyboard.type(" #", { delay: 5 });
      await expect(page.getByTestId("quick-invoke-menu")).toBeVisible({ timeout: 5000 });
      await page.keyboard.type("bs-chip", { delay: 10 });
      await expect(page.getByTestId("quick-invoke-menu")).toContainText(targetName, { timeout: 8000 });
      await page.keyboard.press("Enter");

      // 验证 chip 已插入
      const chip = page.locator('[data-testid="composer-input"] .chip-file').first();
      await expect(chip).toBeVisible({ timeout: 3000 });

      // 把光标显式放到 chip 之后（选中项插入的 token 带尾随空格，
      // 光标若在空格之后，一次 Backspace 只会删空格而不是 chip），
      // 再按一次 Backspace：chip 为 contenteditable=false 的原子节点，浏览器原生整体删除
      await textbox.evaluate((el) => {
        const chipEl = el.querySelector(".chip-file");
        if (!chipEl) throw new Error("chip not found");
        el.focus();
        const range = document.createRange();
        range.setStartAfter(chipEl);
        range.collapse(true);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
      });
      await page.keyboard.press("Backspace");

      // chip 应消失
      await expect(page.locator('[data-testid="composer-input"] .chip-file')).toHaveCount(0, { timeout: 3000 });
    } finally {
      if (existsSync(targetPath)) unlinkSync(targetPath);
    }
  });
});
