// 消息内附件 chip（「附件:文件名」）点击打开：发送出去之后，点击附件 → 文件预览、点击图片 → 媒体画廊。
import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createProject, saveProvider } from "./helpers";

// 1x1 PNG（最小合法图片，避免依赖外部素材）
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test.describe.serial("消息内附件 chip 点击打开", () => {
  test.beforeEach(async ({ page }) => {
    const projectName = `e2e-chip-open-${randomUUID().slice(0, 8)}`;
    await page.goto("/");
    await createProject(projectName, `/tmp/${projectName}`);
    await saveProvider({
      id: "e2e-chip-open-provider",
      name: "E2E ChipOpen",
      slug: "e2e-chip-open",
      baseUrl: "http://localhost:9999/v1",
      apiKey: "sk-e2e",
      api: "openai-completions",
      models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
    });
  });

  /** 新建会话并带附件发送第一条消息（真实用户路径：附件 chip 随后出现在消息气泡里） */
  async function enterSessionWithAttachment(
    page: import("@playwright/test").Page,
    text: string,
    filePath: string,
    fileName: string,
  ): Promise<void> {
    await page.goto("/");
    await expect(page.getByTestId("new-session-pane")).toBeVisible({ timeout: 5000 });
    // 必须先选择模型，否则发送按钮被禁用
    await page
      .getByTestId("model-selector")
      .selectOption({ label: "E2E ChipOpen/model-a" });
    const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');
    await textbox.fill(text);
    await page.setInputFiles(
      '[data-testid="composer-input"] input[type="file"]',
      filePath,
    );
    await expect(page.getByTestId("attachment-list")).toContainText(fileName);

    const sendBtn = page.getByTestId("composer-send");
    await expect(sendBtn).toBeEnabled({ timeout: 5000 });
    await sendBtn.click();
    await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 5000 });
  }

  test("文件附件：发送后点击消息内 chip → 弹出文件预览并显示内容", async ({ page }) => {
    const tmpDir = join(process.env.HOME || "/tmp", ".wa-pi-e2e-chip-open");
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
    const tmpPath = join(tmpDir, "e2e-chip-open.txt");
    writeFileSync(tmpPath, "这是 E2E 附件点击内容", "utf8");

    try {
      await enterSessionWithAttachment(
        page,
        "看看这个附件",
        tmpPath,
        "e2e-chip-open.txt",
      );

      // 消息里的附件 chip（乐观占位即出现；pi 回声后由正文尾段重建，同一渲染路径）
      const chip = page
        .locator('[data-testid="session-view"] .chip-attachment')
        .first();
      await expect(chip).toBeVisible({ timeout: 10_000 });
      await expect(chip).toHaveText("附件:e2e-chip-open.txt");
      await chip.click();

      // 点击 → 全局文件预览弹窗，内容可见
      const modal = page.getByTestId("file-preview-modal");
      await expect(modal).toBeVisible({ timeout: 10_000 });
      await expect(modal).toContainText("这是 E2E 附件点击内容");
    } finally {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    }
  });

  test("图片附件：发送后点击消息内 chip → 弹出媒体画廊", async ({ page }) => {
    const tmpDir = join(process.env.HOME || "/tmp", ".wa-pi-e2e-chip-open");
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
    const tmpPath = join(tmpDir, "e2e-chip-open.png");
    writeFileSync(tmpPath, Buffer.from(PNG_BASE64, "base64"));

    try {
      await enterSessionWithAttachment(
        page,
        "看看这张图",
        tmpPath,
        "e2e-chip-open.png",
      );

      const chip = page
        .locator('[data-testid="session-view"] .chip-attachment')
        .first();
      await expect(chip).toBeVisible({ timeout: 10_000 });
      await expect(chip).toHaveText("附件:e2e-chip-open.png");
      await chip.click();

      // 点击 → 媒体画廊（图片预览）弹窗，头部显示文件名（单媒体不渲染 i/N 计数）
      const modal = page.getByTestId("media-preview-modal");
      await expect(modal).toBeVisible({ timeout: 10_000 });
      await expect(modal).toContainText("e2e-chip-open.png");
    } finally {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    }
  });
});
