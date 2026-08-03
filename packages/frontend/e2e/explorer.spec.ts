// 文件树 + 文件预览 E2E：进入项目会话→点文件树按钮→面板展开→文件树渲染→双击预览
// 依赖 global-setup 预置的 e2e-project（cwd=<WA_PI_DIR>/e2e-project，含 AGENTS.md）
import { test, expect } from "@playwright/test";
import { createSessionViaPrompt } from "./helpers";

// 通过 REST 创建一个 e2e-project 会话并返回 id（与 default-workspace.spec 同款，绕过真实 LLM）
async function createSession(): Promise<string> {
  const session = await createSessionViaPrompt("e2e-proj-1", {
    agentName: "dev", text: "e2e", model: "test-model",
    sessionId: "s-exp-" + Math.random().toString(36).slice(2),
  });
  return session.id;
}

test.describe.serial("文件树 + 文件预览", () => {

  test("会话 header 含文件树按钮，点击展开右侧面板 + 文件树渲染 + 双击预览", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto("/");
    await page.waitForTimeout(2000);

    const sessionId = await createSession();
    // 点击侧栏的 e2e-project 进入，再按 testid 点刚创建的会话行（确定性选中，
    // 不依赖标题文本；window.__waPiSelectSession 兜底已随 store 未挂载而失效，移除）
    await page.getByText("E2E项目").first().click();
    await page.getByTestId(`session-${sessionId}`).click();
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

  test("双击 md 文件渲染为 markdown（标题/表格），不显示原始源码", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto("/");
    await page.waitForTimeout(2000);

    const sessionId = await createSession();
    await page.getByText("E2E项目").first().click();
    await page.getByTestId(`session-${sessionId}`).click();
    await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 8000 });

    await page.getByTestId("btn-explorer").click();
    await expect(page.getByTestId("explorer-aside")).toBeVisible({ timeout: 5000 });

    const fileNode = page.locator('[data-testid="explorer-panel"]').getByText("PREVIEW.md");
    await expect(fileNode).toBeVisible({ timeout: 5000 });
    await fileNode.dblclick();

    await expect(page.getByTestId("file-viewer")).toBeVisible({ timeout: 5000 });
    // 限定 file-viewer 作用域：消息气泡（text-bubble）里也有同款 text-block testid，避免 strict mode 二义性
    const textBlock = page.getByTestId("file-viewer").getByTestId("text-block");
    await expect(textBlock).toBeVisible({ timeout: 5000 });
    await expect(textBlock.locator("h1")).toContainText("E2E 预览测试");
    await expect(textBlock.locator("table")).toBeVisible();
    // mermaid 代码块经 createMarkdownComponents 渲染为图表（异步渲染，超时放宽）
    await expect(textBlock.locator('[data-testid="mermaid-svg"]')).toBeVisible({ timeout: 15000 });
    // md 渲染不走 FileViewer 的 Prism 分支：无行号容器
    await expect(page.getByTestId("file-viewer").locator("[data-line]")).toHaveCount(0);
  });

  test("双击不支持预览的文件：显示「在系统查看文件」按钮", async ({ page }) => {
    test.setTimeout(60_000);
    await page.goto("/");
    await page.waitForTimeout(2000);

    const sessionId = await createSession();
    await page.getByText("E2E项目").first().click();
    await page.getByTestId(`session-${sessionId}`).click();
    await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 8000 });

    await page.getByTestId("btn-explorer").click();
    await expect(page.getByTestId("explorer-aside")).toBeVisible({ timeout: 5000 });

    const zipNode = page.locator('[data-testid="explorer-panel"]').getByText("sample.zip");
    await expect(zipNode).toBeVisible({ timeout: 5000 });
    await zipNode.dblclick();

    // unsupported 占位 + 「在系统查看文件」按钮（点击行为由组件测试覆盖，避免 E2E 真实弹出资源管理器）
    await expect(page.getByTestId("fv-unsupported")).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("fv-unsupported")).toContainText("不支持预览该文件");
    await expect(page.getByRole("button", { name: "在系统查看文件" })).toBeVisible({ timeout: 5000 });
  });
});
