import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { saveProvider } from "./helpers";

// 事故：多轮会话里点「重新发送」，此前几轮的历史消息在界面上整段消失，
// 切走会话再切回（重新拉取历史）才恢复。
// 根因：重发传给 truncate 的是渲染行下标——渲染行把 toolResult 折进上一行、
// 把同回合的多条 assistant 合并成一行，行数远小于消息条数，于是切片位置前移，
// 把本应保留的前序回合一起裁掉。
//
// 本用例在真实内核 + 真实浏览器里复现：第一轮带一次工具调用（产生 toolResult 折叠），
// 第二轮以 fatal 401 失败 → 出现「重新发送」→ 点击后断言第一轮的回答仍在列表里。
test.describe("重新发送：历史消息不被过量裁剪", () => {
  let server: Server;
  let providerBaseUrl = "";

  test.beforeAll(async () => {
    // 假 provider 按请求内容分三种响应：
    //  ① 尚无 assistant 消息 → 发起一次工具调用（让历史里出现 toolResult）
    //  ② 末条是工具结果 → 正常文本回答，结束第一轮
    //  ③ 其余（第二轮 / 重发）→ 401 fatal，让「重新发送」按钮出现
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        let msgs: any[] = [];
        try {
          msgs = JSON.parse(raw).messages ?? [];
        } catch {
          msgs = [];
        }
        const last = msgs[msgs.length - 1];
        const hasAssistant = msgs.some((m) => m?.role === "assistant");
        const sendChunk = (delta: any, finishReason: string | null = null) => {
          res.write(
            `data: ${JSON.stringify({
              id: "chatcmpl-e2e",
              object: "chat.completion.chunk",
              created: 1,
              model: "model-a",
              choices: [{ index: 0, delta, finish_reason: finishReason }],
            })}\n\n`,
          );
        };
        if (!hasAssistant) {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          sendChunk({ role: "assistant", content: "" });
          sendChunk({
            tool_calls: [
              {
                index: 0,
                id: "call_e2e_resend",
                type: "function",
                function: {
                  name: "bash",
                  arguments: JSON.stringify({ command: "echo e2e-resend" }),
                },
              },
            ],
          });
          sendChunk({}, "tool_calls");
          res.end("data: [DONE]\n\n");
          return;
        }
        if (last?.role === "tool") {
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          sendChunk({ role: "assistant", content: "" });
          sendChunk({ content: "第一轮回答" });
          sendChunk({}, "stop");
          res.end("data: [DONE]\n\n");
          return;
        }
        res.writeHead(401, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            error: { message: "invalid api key", type: "invalid_request_error" },
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    providerBaseUrl = `http://127.0.0.1:${port}/v1`;
  });

  test.afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  test("多轮会话点重新发送 → 前序回合消息仍在列表里", async ({ page }) => {
    await saveProvider({
      id: "e2e-resend-history-provider",
      name: "E2E ResendHistory",
      slug: "e2e_resend_history",
      baseUrl: providerBaseUrl,
      apiKey: "sk-e2e",
      api: "openai-completions",
      models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
    });

    await page.goto("/");
    await expect(page.getByTestId("new-session-pane")).toBeVisible({
      timeout: 5000,
    });
    await page.getByTestId("model-selector").selectOption({
      label: "E2E ResendHistory/model-a",
    });

    const textbox = page.locator(
      '[data-testid="composer-input"] [role="textbox"]',
    );

    // 第一轮：工具调用 → 工具结果 → 文本回答（历史里 4 条消息，渲染只有 2 行）
    await textbox.fill("第一轮问题");
    await page.getByTestId("composer-send").click();
    await expect(page.getByTestId("message-list")).toContainText("第一轮回答", {
      timeout: 60000,
    });

    // 第二轮：401 fatal → 出现「重新发送」
    await textbox.fill("失败的那条");
    await page.getByTestId("composer-send").click();
    const resend = page.locator('[data-testid^="resend-"]');
    await expect(resend).toBeVisible({ timeout: 60000 });

    // 重发前：第一轮内容在
    await expect(page.getByTestId("message-list")).toContainText("第一轮回答");

    await resend.click();

    // 重发后：第一轮内容仍在（渲染行下标被当成消息下标时，这里会整段消失）
    await expect(page.getByTestId("message-list")).toContainText("第一轮回答");
    // 失败的那条用户消息被重建成新气泡
    await expect(page.getByTestId("message-list")).toContainText("失败的那条");
    // 前序回合的用户消息也还在
    await expect(page.getByTestId("message-list")).toContainText("第一轮问题");
  });
});
