import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createProject, saveProvider } from "./helpers";

// Task 18: Composer 重构 E2E 测试
// 覆盖模型切换、思考开关持久化、文件/片段附件发送与消息列表展示。
test.describe.serial("Composer 重构", () => {
  let projectId = "";

  test.beforeEach(async ({ page }) => {
    // 1. 创建隔离测试项目
    const projectName = `e2e-composer-${randomUUID().slice(0, 8)}`;
    await page.goto("/");
    const project = await createProject(projectName, `/tmp/${projectName}`);
    projectId = project.id;

    // 2. 预置模型供应商，让 ModelSelector 有可选项。
    // 显式 slug + 唯一名称：全套 spec 共享 kernel，多个 spec 都建过名为 "E2E" 的 provider，
    // name 派生 slug 会撞车加后缀（e2e-2/e2e-3…），导致 selectOption 按 label 选中别家的 option
    await saveProvider({
      id: "e2e-composer-provider",
      name: "E2E Composer",
      slug: "e2e-composer",
      baseUrl: "http://localhost:9999/v1",
      apiKey: "sk-e2e",
      api: "openai-completions",
      models: [
        { id: "model-a", contextWindow: 128000, maxTokens: 4096 },
        { id: "model-b", contextWindow: 128000, maxTokens: 4096 },
      ],
    });
  });

  // 进入 session 视图并返回 sessionId（按标题定位 sidebar 会话行：kernel 的 getCommands 兜底
  // 会为新建页的随机 sessionId 预建空标题会话，首行/无前缀匹配可能误抓）
  async function enterSession(page: import("@playwright/test").Page, text: string): Promise<string> {
    await page.goto("/");
    await expect(page.getByTestId("new-session-pane")).toBeVisible({ timeout: 5000 });
    // 必须先选择模型，否则发送按钮被禁用
    await page.getByTestId("model-selector").selectOption({ label: "E2E Composer/model-a" });
    await page.locator('[data-testid="composer-input"] [role="textbox"]').fill(text);
    await page.getByTestId("composer-send").click();
    await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 5000 });
    const testid = await page.locator(`aside [data-testid^="session-"]:has-text("${text}")`).first().getAttribute("data-testid");
    return testid?.replace("session-", "") ?? "";
  }

  test("模型切换并发送消息", async ({ page }) => {
    await enterSession(page, "模型切换测试");

    const selector = page.getByTestId("model-selector");
    await expect(selector).toBeVisible();

    // 初始为空（未选择），切换到 model-b（option label 为 E2E Composer/model-b，value 为 e2e-composer/model-b）
    await selector.selectOption({ label: "E2E Composer/model-b" });
    await expect(selector).toHaveValue("e2e-composer/model-b");

    const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');
    await textbox.fill("使用 model-b 发送");
    await page.getByTestId("composer-send").click();

    // 发送后输入框清空
    await expect(textbox).toBeEmpty(); // contenteditable 无 value，断言文本为空
    // 用户消息出现在消息列表
    await expect(page.getByText("使用 model-b 发送").first()).toBeVisible({ timeout: 8000 });
  });

  test("思考强度选择持久化", async ({ page }) => {
    const sessionId = await enterSession(page, "思考强度持久化测试");

    const selector = page.getByTestId("thinking-selector");
    await expect(selector).toHaveValue("disabled");

    await selector.selectOption("high");
    await expect(selector).toHaveValue("high");

    // 等待 IndexedDB 异步写入完成后再刷新
    await page.waitForTimeout(500);

    // 刷新后重新进入同一会话，思考强度应从 IndexedDB 恢复为 high
    await page.reload();
    await page.getByTestId(`session-${sessionId}`).click();
    await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("thinking-selector")).toHaveValue("high");
  });

  test("文件附件发送流程", async ({ page }) => {
    const sessionId = await enterSession(page, "文件附件测试");
    const tmpDir = join(process.env.HOME || "/tmp", ".wa-pi-e2e-composer");
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
    const tmpPath = join(tmpDir, "e2e-attachment.txt");
    writeFileSync(tmpPath, "这是 E2E 文件附件内容", "utf8");

    try {
      // 选择文件（触发 hidden file input）后自动上传到项目目录
      await page.setInputFiles('[data-testid="composer-input"] input[type="file"]', tmpPath);

      // 等待上传完成、附件 chip 出现在列表
      await expect(page.getByTestId("attachment-list")).toContainText("e2e-attachment.txt");

      const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');
      await textbox.fill("查看文件附件");
      await page.getByTestId("composer-send").click();

      // 发送后附件列表清空
      await expect(page.getByTestId("attachment-list")).not.toBeVisible();
      await expect(textbox).toBeEmpty(); // contenteditable 无 value，断言文本为空
      // 消息列表中只显示用户原文，不出现 @路径引用或 [附件: ...]
      await expect(page.getByText("查看文件附件").first()).toBeVisible({ timeout: 8000 });
      await expect(page.locator("text=@.wa-pi/uploads")).not.toBeVisible();
    } finally {
      // 清理临时附件文件
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    }
  });

  test("片段附件发送流程", async ({ page }) => {
    const sessionId = await enterSession(page, "片段附件测试");

    // 当前 Composer UI 没有提供添加 snippet 的入口，通过 IndexedDB 直接写入附件草稿模拟已添加
    await page.evaluate((sid) => {
      return new Promise<void>((resolve, reject) => {
        const req = indexedDB.open("wa-pi-composer", 1);
        req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("sessions")) {
            db.createObjectStore("sessions", { keyPath: "sessionId" });
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction("sessions", "readwrite");
          const store = tx.objectStore("sessions");
          const put = store.put({
            sessionId: sid,
            model: "model-a",
            thinking: "disabled",
            attachments: [{ kind: "snippet", name: "test-snippet", content: "console.log('e2e');" }],
            updatedAt: Date.now(),
          });
          put.onsuccess = () => resolve();
          put.onerror = () => reject(put.error ?? new Error("indexedDB put failed"));
        };
      });
    }, sessionId);

    // 刷新后 Composer 从 IndexedDB 加载，片段附件 chip 应出现
    await page.reload();
    await page.getByTestId(`session-${sessionId}`).click();
    await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("attachment-list")).toContainText("console.log('e2e');");

    const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');
    await textbox.fill("请查看片段");
    await page.getByTestId("composer-send").click();

    // 发送后附件列表清空
    await expect(page.getByTestId("attachment-list")).not.toBeVisible();
    await expect(textbox).toBeEmpty(); // contenteditable 无 value，断言文本为空
    // 消息列表中出现片段引用
    await expect(page.getByText("[片段: test-snippet]").first()).toBeVisible({ timeout: 8000 });
  });

  test("草稿：切会话回来恢复", async ({ page }) => {
    // 会话 A（已有草稿）→ 切到新建页 → 切回会话 A
    const sidA = await enterSession(page, "草稿会话A");
    const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');
    await textbox.fill("写了一半的草稿");
    await page.waitForTimeout(400); // 等防抖写回

    await page.getByTestId("new-session-btn").click();
    await expect(page.getByTestId("new-session-pane")).toBeVisible({ timeout: 5000 });

    await page.getByTestId(`session-${sidA}`).click();
    await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 5000 });
    await expect(textbox).toHaveText("写了一半的草稿");
  });

  test("草稿：刷新后恢复", async ({ page }) => {
    const sidA = await enterSession(page, "草稿刷新会话");
    const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');
    await textbox.fill("刷新后仍在的草稿");
    await page.waitForTimeout(400); // 等防抖写回 IndexedDB

    await page.reload();
    await page.getByTestId(`session-${sidA}`).click();
    await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 5000 });
    await expect(textbox).toHaveText("刷新后仍在的草稿");
  });

  test("草稿：发送后清空", async ({ page }) => {
    const sidA = await enterSession(page, "草稿发送会话");
    const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');
    await textbox.fill("发送后不应残留");
    await page.waitForTimeout(400);
    await page.getByTestId("composer-send").click();
    await expect(textbox).toBeEmpty();

    await page.getByTestId("new-session-btn").click();
    await expect(page.getByTestId("new-session-pane")).toBeVisible({ timeout: 5000 });
    await page.getByTestId(`session-${sidA}`).click();
    await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 5000 });
    await expect(textbox).toBeEmpty();
  });

  test("草稿：手动清空输入框后不复活", async ({ page }) => {
    const sidA = await enterSession(page, "草稿清空会话");
    const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');
    await textbox.fill("将被手动清空");
    await page.waitForTimeout(400);
    await textbox.fill(""); // 手动清空 = 放弃草稿
    await page.waitForTimeout(400);

    await page.getByTestId("new-session-btn").click();
    await expect(page.getByTestId("new-session-pane")).toBeVisible({ timeout: 5000 });
    await page.getByTestId(`session-${sidA}`).click();
    await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 5000 });
    await expect(textbox).toBeEmpty();
  });

  test("草稿：新建页输入切走再回来恢复", async ({ page }) => {
    // 先建一个真实会话，用于"切走"
    await enterSession(page, "草稿切走会话");
    const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');

    // 回到新建页输入草稿
    await page.getByTestId("new-session-btn").click();
    await expect(page.getByTestId("new-session-pane")).toBeVisible({ timeout: 5000 });
    await textbox.fill("新建页的草稿");
    await page.waitForTimeout(400);

    // 切到已有会话再切回新建页
    await page.locator('aside [data-testid^="session-"]').first().click();
    await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 5000 });
    await page.getByTestId("new-session-btn").click();
    await expect(page.getByTestId("new-session-pane")).toBeVisible({ timeout: 5000 });
    await expect(textbox).toHaveText("新建页的草稿");
  });

  test("草稿：删除会话后其草稿不残留", async ({ page }) => {
    const sidA = await enterSession(page, "草稿删除会话");
    const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');
    await textbox.fill("将被删除的草稿");
    await page.waitForTimeout(400); // 等防抖写回 IndexedDB

    // 右键删除会话并确认
    await page.getByTestId(`session-${sidA}`).click({ button: "right" });
    await page.getByTestId("menu-delete").click();
    await page.getByTestId("confirm-ok").click();
    await page.waitForTimeout(400); // 等 removeSessionPrefs 的异步 IDB delete 落盘

    // 删除后 IndexedDB 中该会话的草稿记录应被清除
    const removed = await page.evaluate((sid) => {
      return new Promise<boolean>((resolve) => {
        const req = indexedDB.open("wa-pi-composer", 1);
        req.onerror = () => resolve(false);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("sessions")) { resolve(true); db.close(); return; }
          const tx = db.transaction("sessions", "readonly");
          const get = tx.objectStore("sessions").get(sid);
          get.onsuccess = () => { resolve(get.result === undefined); db.close(); };
          get.onerror = () => { resolve(false); db.close(); };
        };
      });
    }, sidA);
    expect(removed).toBe(true);
  });
});
