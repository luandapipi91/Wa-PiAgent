import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";

// Task 8: Quick Invoke 聊天栏快速调用 E2E 测试
//
// 覆盖：
// 1. `@` 触发文件选择面板 → 选中 → chip 内联插入（橙色）→ 发送时展开为 `@相对路径`
// 2. `$` 触发技能选择面板 → 选中 → chip 内联插入（靛蓝）→ 发送时展开为 `$技能名`
// 3. Esc 关闭面板但保留触发符文本
// 4. Backspace 删除整个 chip
//
// 约定：
// - 复用 composer.spec.ts 的 beforeEach 隔离项目模式（WS project:create + provider:save）
// - 技能通过 globalSetup 注入的内置技能或 skillDir:add 动态添加的测试技能驱动
// - 输入框为 contenteditable div，selector 使用 [role="textbox']
// - 文件搜索依赖 projectCwd 下的真实文件 —— 测试在项目 cwd 下预置文件
// - 截图清理：所有测试产生的临时文件 / 目录在 finally / afterAll 中删除
/** 通过 WS 发送消息并等待 settle（可选等待特定响应类型） */
async function wsSend(payload: object, waitForType?: string, timeoutMs = 5000): Promise<any> {
  const ws = new WebSocket("ws://127.0.0.1:9776");
  await new Promise<void>((res, rej) => {
    ws.addEventListener("open", () => res(), { once: true });
    ws.addEventListener("error", () => rej(new Error("ws connect failed")), { once: true });
  });
  try {
    if (waitForType) {
      const result = await new Promise<any>((res, rej) => {
        const timer = setTimeout(() => rej(new Error(`等待 ${waitForType} 超时`)), timeoutMs);
        ws.addEventListener("message", (ev) => {
          const e = JSON.parse(String((ev as MessageEvent).data));
          if (e.type === waitForType) { clearTimeout(timer); res(e); }
        });
      });
      ws.send(JSON.stringify(payload));
      return result;
    } else {
      // 无需等待特定响应，给服务端处理时间后关闭
      ws.send(JSON.stringify(payload));
      await new Promise(r => setTimeout(r, 300));
      return undefined;
    }
  } finally {
    ws.close();
  }
}

test.describe.serial("Quick Invoke 聊天栏快速调用", () => {
  let projectId = "";
  let projectCwd = "";

  test.beforeEach(async () => {
    // 1. 创建隔离测试项目（带真实 cwd，便于 @ 文件搜索）
    const projectName = `e2e-quick-invoke-${randomUUID().slice(0, 8)}`;
    projectCwd = `/tmp/${projectName}`;
    const created = await wsSend({ type: "project:create", name: projectName, cwd: projectCwd }, "project:created");
    projectId = created.project.id;

    // 2. 预置模型供应商，让 ModelSelector 有可选项
    await wsSend({
      type: "provider:save",
      provider: {
        id: "e2e-quick-invoke-provider",
        name: "E2E",
        baseUrl: "http://localhost:9999/v1",
        apiKey: "sk-e2e",
        api: "openai-completions",
        models: [
          { id: "model-a", contextWindow: 128000, maxTokens: 4096 },
        ],
      },
    });
  });

  // 进入 session 视图（仿 composer.spec.ts 的 enterSession）
  async function enterSession(page: import("@playwright/test").Page, text: string): Promise<string> {
    await page.goto("/");
    await expect(page.getByTestId("new-session-pane")).toBeVisible({ timeout: 5000 });
    await page.getByTestId("model-selector").selectOption({ label: "E2E/model-a" });
    const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');
    await textbox.click();
    await page.keyboard.type(text, { delay: 5 });
    await page.getByTestId("composer-send").click();
    await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 8000 });
    const testid = await page.locator('[data-testid^="session-"]').first().getAttribute("data-testid");
    return testid?.replace("session-", "") ?? "";
  }

  test("输入 @ 选文件 → chip 显示 → 发送时展开", async ({ page }) => {
    // 在项目 cwd 预置一个可搜索的文件（searchFilesStream 扫描真实文件系统）
    mkdirSync(projectCwd, { recursive: true });
    const targetName = "hello-quick.txt";
    const targetPath = join(projectCwd, targetName);
    writeFileSync(targetPath, "hello quick invoke", "utf8");

    try {
      await enterSession(page, "发起会话");

      const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');

      // 1. 输入空格 + @（@ 必须在行首或空格之后才触发）
      await textbox.click();
      await page.keyboard.type(" ", { delay: 5 });
      await page.keyboard.type("@", { delay: 5 });

      // 2. 等待 Quick Invoke 文件面板出现
      await expect(page.getByTestId("quick-invoke-menu")).toBeVisible({ timeout: 5000 });

      // 3. 输入文件名过滤，等待目标文件出现在列表
      await page.keyboard.type("hello", { delay: 10 });
      await expect(page.getByTestId("quick-invoke-menu")).toContainText(targetName, { timeout: 8000 });

      // 4. Enter 选中第一项
      await page.keyboard.press("Enter");

      // 5. 验证 chip 出现在输入框（橙色 chip-file，data-token 含 @[...]）
      await expect(page.locator('[data-testid="composer-input"] .chip-file').first()).toBeVisible({ timeout: 3000 });
      await expect(textbox).toContainText(targetName);

      // 6. 输入附加文本
      await page.keyboard.type(" 查看这个文件", { delay: 5 });

      // 7. 点击发送
      await page.getByTestId("composer-send").click();

      // 8. 发送后输入框清空
      await expect(textbox).toBeEmpty({ timeout: 3000 });

      // 9. 验证发送的消息中 chip 展开为 @hello-quick.txt 纯文本（无方括号）
      await expect(page.getByText(`@${targetName}`).first()).toBeVisible({ timeout: 8000 });
      // 不应出现原始 token 形式 @[...]
      await expect(page.locator(`text=@\\[${targetName}\\]`)).toHaveCount(0);
    } finally {
      if (existsSync(targetPath)) unlinkSync(targetPath);
    }
  });

  test("输入 $ 选技能 → chip 显示 → 发送时展开", async ({ page }) => {
    // 预置一个技能目录 + 测试技能（skillDir:add 触发 kernel 重扫，skill:changed 回推）
    const skillDirRoot = join(process.env.HOME || "/tmp", `.hiagent-e2e-quick-invoke-skills-${randomUUID().slice(0, 8)}`);
    const skillPkgDir = join(skillDirRoot, "e2e-qi-skill");
    mkdirSync(skillPkgDir, { recursive: true });
    writeFileSync(
      join(skillPkgDir, "SKILL.md"),
      "---\nname: e2e-qi-skill\ndescription: E2E Quick Invoke 测试技能\n---\n# e2e-qi-skill\n测试用",
      "utf8",
    );

    try {
      // 通过 WS 把技能目录加到 kernel（等待 skill:changed 回推，避免 setTimeout 竞态）
      await wsSend({ type: "skillDir:add", path: skillDirRoot }, "skill:changed");

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

      // 7. 验证发送的消息中 chip 展开为 $e2e-qi-skill
      await expect(page.getByText("$e2e-qi-skill").first()).toBeVisible({ timeout: 8000 });
      await expect(page.locator(`text=\\$\\[e2e-qi-skill\\]`)).toHaveCount(0);
    } finally {
      if (existsSync(skillDirRoot)) rmSync(skillDirRoot, { recursive: true, force: true });
    }
  });

  test("Esc 关闭面板保留触发符文本", async ({ page }) => {
    // 预置技能（确保 `$` 触发后面板会有内容；detectTrigger 不需要内容即可触发，但
    // 此用例验证的是「Esc 后面板消失、文本保留」，面板有无项不影响 Esc 行为）
    const skillDirRoot = join(process.env.HOME || "/tmp", `.hiagent-e2e-quick-invoke-esc-${randomUUID().slice(0, 8)}`);
    const skillPkgDir = join(skillDirRoot, "e2e-esc-skill");
    mkdirSync(skillPkgDir, { recursive: true });
    writeFileSync(
      join(skillPkgDir, "SKILL.md"),
      "---\nname: e2e-esc-skill\ndescription: Esc 测试\n---\n# e2e-esc-skill",
      "utf8",
    );

    try {
      // 等待 skill:changed 回推，避免 setTimeout 竞态
      await wsSend({ type: "skillDir:add", path: skillDirRoot }, "skill:changed");

      await enterSession(page, "Esc 测试会话");

      const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');
      await textbox.click();
      await page.keyboard.type("$", { delay: 5 });
      await expect(page.getByTestId("quick-invoke-menu")).toBeVisible({ timeout: 5000 });

      // 输入部分查询
      await page.keyboard.type("brain", { delay: 10 });

      // 按 Esc
      await page.keyboard.press("Escape");

      // 面板消失
      await expect(page.getByTestId("quick-invoke-menu")).toHaveCount(0, { timeout: 3000 });

      // 输入框保留 $brain 文本
      await expect(textbox).toContainText("$brain");
    } finally {
      if (existsSync(skillDirRoot)) rmSync(skillDirRoot, { recursive: true, force: true });
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
      await page.keyboard.type(" @", { delay: 5 });
      await expect(page.getByTestId("quick-invoke-menu")).toBeVisible({ timeout: 5000 });
      await page.keyboard.type("bs-chip", { delay: 10 });
      await expect(page.getByTestId("quick-invoke-menu")).toContainText(targetName, { timeout: 8000 });
      await page.keyboard.press("Enter");

      // 验证 chip 已插入
      const chip = page.locator('[data-testid="composer-input"] .chip-file').first();
      await expect(chip).toBeVisible({ timeout: 3000 });

      // 光标已在 chip 之后；按一次 Backspace 删除整个 chip
      // （chip 为 contenteditable=false 的原子节点，浏览器原生一次 Backspace 删除整个节点）
      await page.keyboard.press("Backspace");

      // chip 应消失
      await expect(page.locator('[data-testid="composer-input"] .chip-file')).toHaveCount(0, { timeout: 3000 });
    } finally {
      if (existsSync(targetPath)) unlinkSync(targetPath);
    }
  });
});
