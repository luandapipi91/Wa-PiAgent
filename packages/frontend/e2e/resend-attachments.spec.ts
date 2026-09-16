import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createProject, saveProvider } from "./helpers";

// 事故：带附件的消息发送失败后点「重新发送」，附件丢失（重发请求不带 attachments）。
// 本用例在真实内核 + 真实浏览器操作下锁住修复的两点：
//   ① 失败回合的用户气泡里附件 chip 仍在（此前只有 pi 回声/历史消息才渲染 chip）
//   ② 重发请求体带原附件（此前 attachments 恒为 undefined）
test.describe("重新发送：附件保留", () => {
  let server: Server;
  let providerBaseUrl = "";

  test.beforeAll(async () => {
    // 立即返回 401 的假 provider：内核按 fatal 处理（不进 pi 自动重试退避），
    // 回合几秒内以 assistant stopReason:error 结束 → 「重新发送」按钮出现
    server = createServer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { message: "invalid api key", type: "invalid_request_error" },
        }),
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    providerBaseUrl = `http://127.0.0.1:${port}/v1`;
  });

  test.afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  test("发送失败 → 点重新发送 → 附件随请求重发且气泡上仍在", async ({
    page,
  }) => {
    const projectName = `e2e-resend-${randomUUID().slice(0, 8)}`;
    await page.goto("/");
    const project = await createProject(projectName, `/tmp/${projectName}`);
    await saveProvider({
      id: "e2e-resend-provider",
      name: "E2E Resend",
      slug: "e2e-resend",
      baseUrl: providerBaseUrl,
      apiKey: "sk-e2e",
      api: "openai-completions",
      models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
    });

    // 记录发送的 prompt 请求体（放行真实请求：让 kernel 真的建会话并接收附件）
    const promptBodies: any[] = [];
    await page.route("**/api/agents/**/prompt", async (route) => {
      const raw = route.request().postData();
      promptBodies.push(raw ? JSON.parse(raw) : {});
      await route.continue();
    });

    await page.goto("/");
    await expect(page.getByTestId("new-session-pane")).toBeVisible({
      timeout: 5000,
    });
    await page.getByTestId("model-selector").selectOption({
      label: "E2E Resend/model-a",
    });

    const tmpDir = join(process.env.HOME || "/tmp", ".wa-pi-e2e-resend");
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
    const fileName = `e2e-resend-${randomUUID().slice(0, 6)}.txt`;
    const tmpPath = join(tmpDir, fileName);
    writeFileSync(tmpPath, "这是 E2E 重新发送附件用例的内容", "utf8");

    try {
      // 选择文件后自动上传到项目 .wa-pi/uploads
      await page.setInputFiles(
        '[data-testid="composer-input"] input[type="file"]',
        tmpPath,
      );
      await expect(page.getByTestId("attachment-list")).toContainText(fileName);

      const textbox = page.locator(
        '[data-testid="composer-input"] [role="textbox"]',
      );
      await textbox.fill("带附件的消息（本次发送会失败）");
      await page.getByTestId("composer-send").click();

      // 回合以 fatal 错误结束 → 「重新发送」按钮出现
      const resend = page.locator('[data-testid^="resend-"]');
      await expect(resend).toBeVisible({ timeout: 30000 });

      // ① 失败回合的用户气泡仍显示附件 chip
      await expect(
        page.getByTestId("message-list").locator(".chip-attachment").first(),
      ).toContainText(`附件:${fileName}`);

      expect(promptBodies.length).toBe(1);
      expect(promptBodies[0].attachments).toHaveLength(1);

      // 点击「重新发送」
      await resend.click();

      // ② 重发请求体带原附件（正文仍是剥掉附件尾段的原文）
      await expect.poll(() => promptBodies.length).toBeGreaterThan(1);
      const resent = promptBodies[promptBodies.length - 1];
      expect(resent.text).toBe("带附件的消息（本次发送会失败）");
      expect(resent.attachments).toHaveLength(1);
      expect(resent.attachments[0].kind).toBe("file");
      expect(resent.attachments[0].path).toContain(
        `.wa-pi/uploads/${fileName}`,
      );

      // 重发后附件 chip 仍在（重试未丢附件）
      await expect(
        page.getByTestId("message-list").locator(".chip-attachment").first(),
      ).toContainText(`附件:${fileName}`);
    } finally {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    }
  });
});
