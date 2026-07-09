import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Task 18: Composer 重构 E2E 测试
// 覆盖模型切换、思考开关持久化、文件/片段附件发送与消息列表展示。
test.describe.serial("Composer 重构", () => {
  let projectId = "";

  test.beforeEach(async ({ page }) => {
    // 1. 创建隔离测试项目
    const projectName = `e2e-composer-${randomUUID().slice(0, 8)}`;
    await page.goto("/");
    projectId = await page.evaluate(async (name) => {
      const ws = new WebSocket("ws://127.0.0.1:9776");
      await new Promise<void>((res, rej) => {
        ws.addEventListener("open", () => res(), { once: true });
        ws.addEventListener("error", () => rej(new Error("ws connect failed")), { once: true });
      });
      const done = new Promise<string>((res) => {
        ws.addEventListener("message", (ev) => {
          const e = JSON.parse(String((ev as MessageEvent).data));
          if (e.type === "project:created") res(e.project.id);
        });
      });
      ws.send(JSON.stringify({ type: "project:create", name, cwd: `/tmp/${name}` }));
      const id = await done;
      ws.close();
      return id;
    }, projectName);

    // 2. 预置模型供应商，让 ModelSelector 有可选项
    await page.evaluate(async () => {
      const ws = new WebSocket("ws://127.0.0.1:9776");
      await new Promise<void>((res) => { ws.addEventListener("open", () => res(), { once: true }); });
      ws.send(JSON.stringify({
        type: "provider:save",
        provider: {
          id: "e2e-composer-provider",
          name: "E2E",
          baseUrl: "http://localhost:9999/v1",
          apiKey: "sk-e2e",
          api: "openai-completions",
          models: [
            { id: "model-a", contextWindow: 128000, maxTokens: 4096 },
            { id: "model-b", contextWindow: 128000, maxTokens: 4096 },
          ],
        },
      }));
      await new Promise(r => setTimeout(r, 300));
      ws.close();
    });
  });

  // 进入 session 视图并返回 sessionId（从 sidebar 的 session row data-testid 解析）
  async function enterSession(page: import("@playwright/test").Page, text: string): Promise<string> {
    await page.goto("/");
    await expect(page.getByTestId("new-session-pane")).toBeVisible({ timeout: 5000 });
    await page.locator('[data-testid="composer-input"] textarea').fill(text);
    await page.getByTestId("composer-send").click();
    await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 5000 });
    const testid = await page.locator('[data-testid^="session-"]').first().getAttribute("data-testid");
    return testid?.replace("session-", "") ?? "";
  }

  test("模型切换并发送消息", async ({ page }) => {
    await enterSession(page, "模型切换测试");

    const selector = page.getByTestId("model-selector");
    await expect(selector).toBeVisible();

    // 初始为空（未选择），切换到 model-b（option label 为 E2E/model-b，value 为 model-b）
    await selector.selectOption({ label: "E2E/model-b" });
    await expect(selector).toHaveValue("model-b");

    const textarea = page.locator('[data-testid="composer-input"] textarea');
    await textarea.fill("使用 model-b 发送");
    await page.getByTestId("composer-send").click();

    // 发送后输入框清空
    await expect(textarea).toHaveValue("");
    // 用户消息出现在消息列表
    await expect(page.getByText("使用 model-b 发送").first()).toBeVisible({ timeout: 8000 });
  });

  test("思考开关状态持久化", async ({ page }) => {
    const sessionId = await enterSession(page, "思考开关持久化测试");

    const toggle = page.getByTestId("thinking-toggle");
    await expect(toggle).toHaveText("思考 关");

    await toggle.click();
    await expect(toggle).toHaveText("思考 high");

    // 等待 IndexedDB 异步写入完成后再刷新
    await page.waitForTimeout(500);

    // 刷新后重新进入同一会话，思考开关应从 IndexedDB 恢复为 high
    await page.reload();
    await page.getByTestId(`session-${sessionId}`).click();
    await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("thinking-toggle")).toHaveText("思考 high");
  });

  test("文件附件发送流程", async ({ page }) => {
    const sessionId = await enterSession(page, "文件附件测试");
    const tmpDir = join(process.env.HOME || "/tmp", ".hiagent-e2e-composer");
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
    const tmpPath = join(tmpDir, "e2e-attachment.txt");
    writeFileSync(tmpPath, "这是 E2E 文件附件内容", "utf8");

    // 选择文件（触发 hidden file input）
    await page.setInputFiles('[data-testid="composer-input"] input[type="file"]', tmpPath);

    // 补填绝对路径弹窗
    await expect(page.getByTestId("path-input")).toBeVisible();
    await page.getByTestId("path-input").fill(tmpPath);
    await page.getByTestId("confirm-path").click();

    // 附件 chip 出现在列表
    await expect(page.getByTestId("attachment-list")).toContainText("e2e-attachment.txt");

    const textarea = page.locator('[data-testid="composer-input"] textarea');
    await textarea.fill("查看文件附件");
    await page.getByTestId("composer-send").click();

    // 发送后附件列表清空
    await expect(page.getByTestId("attachment-list")).not.toBeVisible();
    await expect(textarea).toHaveValue("");
    // 消息列表中出现引用
    await expect(page.getByText("[附件: e2e-attachment.txt]").first()).toBeVisible({ timeout: 8000 });
  });

  test("片段附件发送流程", async ({ page }) => {
    const sessionId = await enterSession(page, "片段附件测试");

    // 当前 Composer UI 没有提供添加 snippet 的入口，通过 IndexedDB 直接写入附件草稿模拟已添加
    await page.evaluate((sid) => {
      return new Promise<void>((resolve, reject) => {
        const req = indexedDB.open("hiagent-composer", 1);
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
            model: null,
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

    const textarea = page.locator('[data-testid="composer-input"] textarea');
    await textarea.fill("请查看片段");
    await page.getByTestId("composer-send").click();

    // 发送后附件列表清空
    await expect(page.getByTestId("attachment-list")).not.toBeVisible();
    await expect(textarea).toHaveValue("");
    // 消息列表中出现片段引用
    await expect(page.getByText("[片段: test-snippet]").first()).toBeVisible({ timeout: 8000 });
  });
});
