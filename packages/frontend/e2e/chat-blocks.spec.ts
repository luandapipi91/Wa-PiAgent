// 聊天块渲染 E2E：过程卡片弱化折叠 / 代码块卡片 / FilePill 预览 / 正文气泡
//
// 验证目标（cocode 显示对齐 Task 6）：
// 单回合真实 LLM 会话中——
// 1. 回合结束后工具卡（toolcall-group 或 toolcall-<id>）根节点 data-muted="true" 且 -body 不渲染；
// 2. markdown 代码块渲染为 code-block-card（头部语言名 + 「复制」按钮）；
// 3. 行内代码中的文件路径渲染为 file-pill，点击弹 file-preview-modal 且含真实文件内容；
// 4. 正文 text-block 可见（视觉重心是正文）。
//
// harness 完全复用 rpc-session.spec.ts 范式：
// - 隔离环境由 global-setup/teardown 提供（独立 WA_PI_DIR + E2E_WS_PORT，目录整体清除即数据清理）
// - deepseek provider 经 REST POST /api/providers 注入，apiKey 从本机 pi 凭证库运行时读取（不落盘）
// - kernel 端口取 playwright.config 的 E2E_WS_PORT（本机 9776 被真实 kernel 占用时可用
//   WA_PI_E2E_WS_PORT 偏移，不能硬编码 9776）
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { saveProvider } from "./helpers";

/**
 * 运行时读 deepseek apiKey（仅测试运行期内存使用，不落盘）。
 * 首选 ~/.pi/agent/auth.json 的 deepseek.key（rpc-session 既有约定）；
 * 本机 pi 凭证库为空时回退到 ~/.wa-pi/providers.json 中 deepseek provider 的 apiKey。
 */
function readDeepseekKey(): string {
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  try {
    const auth = JSON.parse(readFileSync(join(home, ".pi", "agent", "auth.json"), "utf8"));
    const key = auth?.deepseek?.key;
    if (key) return key;
  } catch {}
  try {
    const store = JSON.parse(readFileSync(join(home, ".wa-pi", "providers.json"), "utf8"));
    const list = Array.isArray(store) ? store : (store.providers ?? []);
    const ds = list.find((p: any) => String(p.baseUrl ?? "").includes("deepseek"));
    if (ds?.apiKey) return ds.apiKey;
  } catch {}
  throw new Error("未找到 deepseek apiKey（~/.pi/agent/auth.json 与 ~/.wa-pi/providers.json 均无），无法执行 LLM E2E");
}

// 真实模型偶发不按指令输出 → 允许一次重试（断言不放宽）
test.describe.configure({ retries: 1 });

test("聊天块渲染：工具卡弱化折叠 + 代码块卡片 + FilePill 预览 + 正文可见", async ({ page }) => {
  test.setTimeout(300_000);

  // FilePill 目标文件：packages/frontend/package.json 的绝对路径（真实存在）。
  // 绝对路径不经会话 cwd 解析（FilePill.resolveAbsolutePath 原样返回）。
  // playwright 从 packages/frontend 运行，cwd 即包目录。
  const pkgAbsPath = join(process.cwd(), "package.json");

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

  // 4. 发指令化 prompt（降低模型随机性）：一次 bash + 含 ts 代码块与文件路径行内代码的 markdown
  //    输入框是 contentEditable div（role=textbox），不是 textarea
  await page.getByRole("textbox").fill(
    "严格按以下两步执行，不要省略也不要多做：\n"
    + "第一步：用 bash 工具执行命令 echo ok。\n"
    + "第二步：输出一段 markdown 作为最终回复，必须同时包含：\n"
    + "  a) 一个 ```ts 代码块，内容恰好 5 行 TypeScript 代码（例如 5 条 const 声明）；\n"
    + `  b) 一句普通文字，其中用行内代码提及文件，行内代码里只写路径本身：${pkgAbsPath}`,
  );
  await page.getByTestId("composer-send").click();
  await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 10_000 });

  // 5. 断言一：回合结束后工具卡弱化折叠。
  //    根节点 testid 为 toolcall-group（多工具组卡）或 toolcall-<id>（单工具卡），
  //    排除 -header/-body 后缀节点；muted={!isStreaming}，回合流式结束才置 true。
  const toolCard = page.locator(
    '[data-testid="toolcall-group"], [data-testid^="toolcall-"]:not([data-testid$="-header"]):not([data-testid$="-body"])',
  ).first();
  await expect(toolCard).toBeVisible({ timeout: 180_000 });
  await expect(toolCard).toHaveAttribute("data-muted", "true", { timeout: 180_000 });
  const toolCardId = (await toolCard.getAttribute("data-testid"))!;
  // 回合结束自动折叠：展开体不渲染
  await expect(page.getByTestId(`${toolCardId}-body`)).toHaveCount(0);

  // 6. 断言二：代码块卡片（头部含语言名 ts + 「复制」按钮）
  const codeCard = page.getByTestId("code-block-card").first();
  await expect(codeCard).toBeVisible();
  await expect(codeCard).toContainText("ts");
  await expect(codeCard.getByTestId("code-copy")).toHaveText("复制");

  // 7. 断言三：FilePill 可见，点击弹预览 modal，含真实文件内容（package.json 的 "name" 字段）
  const pill = page.getByTestId("file-pill").first();
  await expect(pill).toBeVisible();
  await pill.click();
  const modal = page.getByTestId("file-preview-modal");
  await expect(modal).toBeVisible();
  await expect(modal).toContainText('"name"', { timeout: 15_000 });

  // 8. 断言四：正文 text-block 可见（视觉重心是正文）
  await expect(page.getByTestId("text-block").last()).toBeVisible();

  // 数据清理：会话/项目均在 E2E_WA_PI_DIR 隔离目录内，由 global-teardown 整体清除；
  // 不产生截图（Playwright 失败产物 test-results/ 由任务流程跑完删除）。
});

// 回归：Prism 的 markdown 语法给表格 token 打 class="token table ..."，与 Tailwind JIT
// 误生成的 .table{display:table} 工具类相撞，曾导致代码卡片内表格逐格竖排。
// styles.css 的防护规则须让 token span 保持 inline。确定性断言真实 CSS 级联，不依赖 LLM。
test("代码卡片内 prism table token 不被 Tailwind .table 工具类竖排", async ({ page }) => {
  await page.goto("/");
  const display = await page.evaluate(() => {
    const card = document.createElement("div");
    card.setAttribute("data-testid", "code-block-card");
    const span = document.createElement("span");
    span.className = "token table table-header-row punctuation";
    span.textContent = "|";
    card.appendChild(span);
    document.body.appendChild(card);
    const d = getComputedStyle(span).display;
    card.remove();
    return d;
  });
  expect(display).toBe("inline");
});
