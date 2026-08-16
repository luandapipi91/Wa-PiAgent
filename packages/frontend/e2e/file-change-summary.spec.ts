// 文件修改清单 E2E：真实 LLM 完整会话，edit 工具修改文件后回复底部渲染修改清单。
//
// 验证目标（「文件修改清单」功能第 7 层 E2E）：
// 创建会话 → 发 prompt 要求 edit 工具改文件 → 回复底部出现 file-change-summary
// → 展开清单显示文件名 → 展开 diff 显示前后差异 → 点击文件名打开预览弹窗。
//
// 流程对齐项目 E2E 约定（AGENTS.md）与 rpc-session.spec.ts：
// - 测试数据经 API 创建：provider 经 REST POST /api/providers 注入（apiKey 从本机
//   ~/.pi/agent/auth.json 的 deepseek 凭证读取，不落盘、不入库到 E2E 隔离目录以外）
// - 用户流程在浏览器执行：选模型 → 发消息 → 断言 DOM
// - 数据清理：E2E_WA_PI_DIR 由 global-teardown 整体清除
//
// 注：dev 智能体 tools 白名单为 read/bash/edit（global-setup.ts 的 DEV_AGENT_MD），
// 不含 write 工具，故用 edit 工具修改既有文件 PREVIEW.md（global-setup 预置）。
// edit 为「修改」态（before 非空），清单条目带 ▸ 展开按钮，可断言 diff。
import { test, expect } from "@playwright/test";
import { readFileSync, rmSync } from "node:fs";
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

test("文件修改清单：edit 改文件 → 回复底部渲染清单 → 展开 diff → 点击文件名开预览", async ({ page }) => {
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

  // 4. 发出明确要求 edit 工具修改文件的 prompt（dev 智能体 tools 白名单含 edit、不含 write，
  //    明确禁用 bash 等其他方式，避免 agent 走不触发文件快照的路径）
  await page.getByRole("textbox").fill(
    "请使用 edit 工具（不要用 bash 或其他方式），把项目根目录下 PREVIEW.md 文件的第一行标题 `# E2E 预览测试` 修改为 `# E2E 预览测试已更新`。改完后用一句话告诉我修改完成。",
  );
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 10_000 });

  // 5. 断言回复底部出现文件修改清单（file_changes 在 agent_end 后上报，真实 LLM 较慢）
  const summary = page.getByTestId("file-change-summary");
  await expect(summary).toBeVisible({ timeout: 120_000 });

  // 6. 展开清单折叠行 → 断言文件条目（文件名）可见
  await summary.locator("button").first().click();
  await expect(summary.getByText(/PREVIEW\.md/)).toBeVisible({ timeout: 10_000 });

  // 7. 修改态：点击条目右侧展开按钮（aria-expanded=false 的条目内按钮）→ 断言 diff 容器出现
  await summary.locator("button[aria-expanded='false']").first().click();
  const diff = page.locator("[data-testid^='diff-']").first();
  await expect(diff).toBeVisible({ timeout: 30_000 });
  await expect(diff).toContainText("已更新");

  // 8. 点击文件名 → 断言全局文件预览弹窗出现
  await summary.getByText(/PREVIEW\.md/).first().click();
  await expect(page.getByTestId("file-preview-modal")).toBeVisible({ timeout: 10_000 });

  // 9. 留证截图（读完即删，AGENTS.md 截图清理规则）
  const shot = "test-results/file-change-summary-e2e.png";
  await page.screenshot({ path: shot, fullPage: true });
  console.log(`[e2e] 证据截图: ${shot}（断言通过后由测试删除）`);
  rmSync(shot, { force: true });
});
