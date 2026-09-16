// 输入框手动调高 E2E（第四层）：真实浏览器拖拽手柄。
// 断言：高度变化 + localStorage 持久化 + 刷新保持 + @ 菜单/ask 浮层仍贴输入框上沿。
// ask 浮层的数据准备复用 ask-stale.spec.ts 模式：projects.json 注入会话记录 +
// page.route 拦截 /messages 注入含未回答 ask toolCall 的 assistant 消息。
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_WA_PI_DIR } from "../playwright.config";
import { createProject, saveProvider } from "./helpers";

const ASK_SESSION_ID = "s-e2e-resize-ask";
const ASK_TOOLCALL_ID = "tc-e2e-resize-ask-1";

const askParams = {
  questions: [
    {
      question: "选择存储方案？",
      header: "存储",
      options: [
        { label: "SQLite", description: "轻量" },
        { label: "PostgreSQL", description: "生产级" },
      ],
    },
  ],
};

/** projects.json 注入一条属于 projectId 的会话记录（模式照 ask-stale.spec.ts seedSession） */
function seedAskSession(projectId: string) {
  const projPath = join(E2E_WA_PI_DIR, "projects.json");
  const data = JSON.parse(readFileSync(projPath, "utf8"));
  if (!data.sessions.some((s: any) => s.id === ASK_SESSION_ID)) {
    data.sessions.push({
      id: ASK_SESSION_ID,
      projectId,
      primaryAgent: "dev",
      title: "E2E调高ask兼容",
      createdAt: 1,
      lastActivity: 1,
      piSessionFile: join(E2E_WA_PI_DIR, "sessions", `${ASK_SESSION_ID}.jsonl`),
    });
    writeFileSync(projPath, JSON.stringify(data, null, 2), "utf8");
  }
  mkdirSync(join(E2E_WA_PI_DIR, "sessions"), { recursive: true });
  writeFileSync(
    join(E2E_WA_PI_DIR, "sessions", `${ASK_SESSION_ID}.jsonl`),
    JSON.stringify({ type: "session", version: 3, id: "e2e-resize-ask-uuid" }) + "\n",
    "utf8",
  );
}

/** 拦截 /messages 与 /asks：注入未回答 ask，使 AskDock 展开为 ask-float-layer */
async function injectAsk(page: Page) {
  await page.route(`**/api/sessions/${ASK_SESSION_ID}/messages`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        type: "session:messages",
        sessionId: ASK_SESSION_ID,
        messages: [
          {
            message: {
              role: "assistant",
              content: [
                { type: "toolCall", id: ASK_TOOLCALL_ID, name: "ask_user_question", arguments: askParams },
              ],
              model: "m",
              stopReason: "tool_use",
              timestamp: 1,
            },
            agentName: "dev",
          },
        ],
        isActive: true,
        thinkingSince: null,
      }),
    }),
  );
  await page.route(`**/api/sessions/${ASK_SESSION_ID}/asks`, (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        type: "session:asks",
        sessionId: ASK_SESSION_ID,
        pending: [ASK_TOOLCALL_ID],
      }),
    }),
  );
}

test.describe.serial("输入框手动调高", () => {
  let projectId = "";

  test.beforeEach(async ({ page }) => {
    const projectName = `e2e-resize-${randomUUID().slice(0, 8)}`;
    await page.goto("/");
    const project = await createProject(projectName, `/tmp/${projectName}`);
    projectId = project.id;
    await saveProvider({
      id: "e2e-resize-provider",
      name: "E2E Resize",
      slug: "e2e-resize",
      baseUrl: "http://localhost:9999/v1",
      apiKey: "sk-e2e",
      api: "openai-completions",
      models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
    });
    // 每个用例从干净的高度状态开始（evaluate 一次性清理，不用 addInitScript——后者在
    // 用例内 reload 时会再次执行，把刚持久化的高度清掉）
    await page.evaluate(() => localStorage.removeItem("wa-pi:composer-height"));
  });

  // 进入 session 视图并返回 sessionId（按标题定位 sidebar 会话行，模式照 composer.spec.ts）
  async function enterSession(page: Page) {
    await page.goto("/");
    await expect(page.getByTestId("new-session-pane")).toBeVisible({ timeout: 5000 });
    await page.getByTestId("model-selector").selectOption({ label: "E2E Resize/model-a" });
    const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');
    await textbox.fill("调整高度测试");
    await page.getByTestId("composer-send").click();
    await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 8000 });
    const testid = await page
      .locator(`aside [data-testid^="session-"]:has-text("调整高度测试")`)
      .first()
      .getAttribute("data-testid");
    const sessionId = testid?.replace("session-", "") ?? "";
    return { textbox, sessionId };
  }

  async function dragHandleUp(page: Page, dy: number) {
    const handle = page.getByTestId("composer-resize-handle");
    await expect(handle).toBeVisible();
    const box = (await handle.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - dy, { steps: 5 });
    await page.mouse.up();
  }

  test("拖拽手柄调整高度并持久化", async ({ page }) => {
    const { textbox, sessionId } = await enterSession(page);
    const before = (await textbox.boundingBox())!;
    await dragHandleUp(page, 100);
    const after = (await textbox.boundingBox())!;
    expect(after.height).toBeGreaterThan(before.height + 80);
    const saved = await page.evaluate(() => localStorage.getItem("wa-pi:composer-height"));
    expect(Number(saved)).toBeGreaterThan(120);

    // 刷新后高度保持（reload 后回到新建会话页，需重新点开会话，模式照 composer.spec.ts）
    await page.reload();
    await page.getByTestId(`session-${sessionId}`).click();
    await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 8000 });
    const persisted = (await textbox.boundingBox())!;
    expect(Math.abs(persisted.height - after.height)).toBeLessThan(2);
  });

  test("调高后 @ 菜单仍贴在输入框上沿", async ({ page }) => {
    const { textbox } = await enterSession(page);
    await dragHandleUp(page, 120);
    await textbox.click();
    await page.keyboard.type("@");
    const menu = page.getByTestId("quick-invoke-menu");
    await expect(menu).toBeVisible({ timeout: 5000 });
    const menuBox = (await menu.boundingBox())!;
    const composerBox = (await page.getByTestId("composer-input").boundingBox())!;
    // 菜单底边应位于 composer 容器顶边之上（bottom-full 锚定，跟随上沿）
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(composerBox.y + 1);
    await page.keyboard.press("Escape");
  });

  test("调高后 ask 浮层仍锚定在输入框上方", async ({ page }) => {
    seedAskSession(projectId);
    await injectAsk(page);
    await page.goto("/");
    const row = page.getByTestId(`session-${ASK_SESSION_ID}`);
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.click();
    await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 10_000 });
    // ask 浮层展开（选项按钮可见，模式照 ask-stale.spec.ts openSession）
    await expect(page.getByRole("button", { name: /PostgreSQL/ })).toBeVisible({ timeout: 10_000 });

    await dragHandleUp(page, 120);
    const floatLayer = page.getByTestId("ask-float-layer");
    await expect(floatLayer).toBeVisible();
    const floatBox = (await floatLayer.boundingBox())!;
    const composerBox = (await page.getByTestId("composer-input").boundingBox())!;
    // 浮层底边（bottom-0 锚定的包裹层下沿即 composer 上沿一带）应贴近输入框顶，不脱节不重叠错位
    expect(floatBox.y + floatBox.height).toBeLessThanOrEqual(composerBox.y + 40);
  });
});
