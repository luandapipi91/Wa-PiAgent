// RPC 迁移验收 E2E：真实 LLM 完整会话
//
// 验证目标（迁移完成标准第 4 条）：
// 创建会话 → 发送 prompt → 收到流式响应 → 至少一次工具执行（bash）在前端可见。
//
// 流程对齐项目 E2E 约定（AGENTS.md）：
// - 测试数据经 API 创建：provider 经 REST POST /api/providers 注入（apiKey 从本机
//   ~/.pi/agent/auth.json 的 deepseek 凭证读取，不落盘、不入库到 E2E 隔离目录以外）
// - 用户流程在浏览器执行：选模型 → 发消息 → 断言 DOM（流式文本 + 工具卡片）
// - 数据清理：E2E_WA_PI_DIR 为固定隔离目录，由 global-teardown 整体清除
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { saveProvider } from "./helpers";

/** 从本机 pi 凭证库读 deepseek apiKey（仅测试运行期内存使用） */
function readDeepseekKey(): string {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  const auth = JSON.parse(readFileSync(join(home, ".pi", "agent", "auth.json"), "utf8"));
  const key = auth?.deepseek?.key;
  if (!key) throw new Error("~/.pi/agent/auth.json 缺少 deepseek.key，无法执行 LLM E2E");
  return key;
}

test("RPC 全链路：建会话 → 发 prompt → 流式响应 + bash 工具执行可见", async ({ page }) => {
  test.setTimeout(180_000);

  // 1. 测试数据：注入 deepseek provider（slug 派生为 deepseek）
  const apiKey = readDeepseekKey();
  await page.goto("/");
  await saveProvider({
    id: randomUUID(),
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    apiKey,
    api: "openai-completions",
    models: [{ id: "deepseek-v4-flash", contextWindow: 1000000, maxTokens: 384000 }],
  });

  // 2. global-setup 已预置项目 e2e-proj-1 → 首页应出现 new-session 面板
  await expect(page.getByTestId("new-session-pane")).toBeVisible({ timeout: 10_000 });

  // 3. 选择模型（DeepSeek/deepseek-v4-flash）
  await page.getByTestId("model-selector").selectOption("deepseek/deepseek-v4-flash");

  // 4. 发出要求工具执行的 prompt（bash echo 的输出可被精确断言）
  //    输入框是 contentEditable div（role=textbox），不是 textarea
  await page.getByRole("textbox").fill(
    "请用 bash 工具执行 `echo e2e-rpc-ok`，然后把命令输出原样告诉我",
  );
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 10_000 });

  // 5. 断言工具执行可见：工具调用组出现（✓=执行成功），展开后可见 bash 明细
  const toolGroup = page.getByTestId("toolcall-group").first();
  await expect(toolGroup).toBeVisible({ timeout: 120_000 });
  await expect(toolGroup).toContainText("✓");
  await toolGroup.click(); // 展开工具明细
  await expect(toolGroup).toContainText("bash");

  // 6. 断言流式响应收到：assistant 文本气泡含 echo 输出内容
  await expect(page.getByTestId("text-block").last()).toContainText("e2e-rpc-ok", { timeout: 120_000 });

  // 7. 留证截图（读完即删，AGENTS.md 截图清理规则）
  const shot = "test-results/rpc-session-e2e.png";
  await page.screenshot({ path: shot, fullPage: true });
  console.log(`[e2e] 证据截图: ${shot}（断言通过后由测试删除）`);
  const { rmSync } = await import("node:fs");
  rmSync(shot, { force: true });
});
