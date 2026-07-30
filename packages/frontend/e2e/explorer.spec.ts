// 文件树 + 文件预览 E2E：进入项目会话→点文件树按钮→面板展开→文件树渲染→双击预览
// 依赖 global-setup 预置的 e2e-project（cwd=<WA_PI_DIR>/e2e-project，含 AGENTS.md）
import { test, expect } from "@playwright/test";
import { E2E_WS_PORT } from "../playwright.config";

// 通过 WS 创建一个 e2e-project 会话并返回 id（与 default-workspace.spec 同款，绕过真实 LLM）
async function createSession(page: import("@playwright/test").Page): Promise<string> {
  return page.evaluate(async (wsPort: number) => {
    const ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    await new Promise<void>((res, rej) => {
      ws.addEventListener("open", () => res(), { once: true });
      ws.addEventListener("error", () => rej(new Error("ws connect failed")), { once: true });
    });
    const sessionId = "s-exp-" + Math.random().toString(36).slice(2);
    const done = new Promise<string>((res, rej) => {
      const to = setTimeout(() => rej(new Error("timeout")), 5000);
      ws.addEventListener("message", (ev) => {
        const e = JSON.parse(String((ev as MessageEvent).data));
        if (e.type === "session:created" && e.session.id === sessionId) {
          clearTimeout(to);
          res(sessionId);
        }
      });
    });
    ws.send(JSON.stringify({
      type: "agent:prompt", projectId: "e2e-proj-1", sessionId,
      agentName: "dev", text: "e2e", model: "test-model",
    }));
    const id = await done;
    ws.close();
    return id;
  }, E2E_WS_PORT);
}

// 选中会话进入 session 视图（前端 projects store 的 selectSession 经 SSE projects:list 驱动；
// 这里直接用前端 store API 在浏览器内切换，避免依赖未暴露的 select HTTP 端点）
async function selectSession(page: import("@playwright/test").Page, sessionId: string) {
  await page.evaluate((sid: string) => {
    // 前端 store 已挂在 window.__WA_PI__（若无则走 UI 点击）；此处兜底走 store
    const w = window as any;
    if (w.__waPiSelectSession) { w.__waPiSelectSession(sid); return; }
  }, sessionId);
}

test.describe.serial("文件树 + 文件预览", () => {

  test("会话 header 含文件树按钮，点击展开右侧面板 + 文件树渲染 + 双击预览", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);

    const sessionId = await createSession(page);
    // 点击侧栏的 e2e-project 进入，再点该会话
    await page.getByText("E2E项目").first().click();
    await page.waitForTimeout(1000);
    // 点击刚创建的会话（标题 explorer-e2e 或用 testid session-row）
    await page.getByText("explorer-e2e").first().click().catch(() => {});
    await page.waitForTimeout(1500);
    // 兜底：若未进 session 视图，用前端内部方式选中
    if (await page.getByTestId("session-view").count() === 0) {
      await selectSession(page, sessionId);
      await page.goto("/");
      await page.waitForTimeout(1500);
    }
    await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 8000 });

    // header 含文件树按钮
    const btn = page.getByTestId("btn-explorer");
    await expect(btn).toBeVisible({ timeout: 5000 });

    // 初始面板未展开
    await expect(page.getByTestId("explorer-aside")).toHaveCount(0);

    // 点击展开
    await btn.click();
    await expect(page.getByTestId("explorer-aside")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("项目文件")).toBeVisible({ timeout: 5000 });

    // 文件树渲染出 AGENTS.md（global-setup 预置的项目指令文件）
    const fileNode = page.locator('[data-testid="explorer-panel"]').getByText("AGENTS.md");
    await expect(fileNode).toBeVisible({ timeout: 5000 });

    // 双击文件 → 下方出现 FileViewer 预览
    await fileNode.dblclick();
    await expect(page.getByTestId("file-viewer")).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("file-viewer")).toContainText("AGENTS.md");
  });
});
