import { test, expect } from "@playwright/test";
import { existsSync, readdirSync, statSync, utimesSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { E2E_WA_PI_DIR, E2E_WS_PORT } from "../playwright.config";
import { createSessionViaPrompt, ensureProvider, saveProvider } from "./helpers";

const API = `http://127.0.0.1:${E2E_WS_PORT}`;

// 默认工作区 E2E：验证 UI 渲染 + 项目下拉默认选中 + 项目右键菜单差异
//
// 说明：本 spec 不依赖真实 LLM API key 与 desktop 启动，只覆盖 UI 层关键行为。
// 完整端到端（agent 真实写文件到 workdir/<createdAt>/）需要 API key + 真实 desktop 环境，
// 由开发者本地手动验证。
//
// 前置：global-setup.ts 已启动 kernel + frontend dev server。

const DAY_MS = 24 * 60 * 60 * 1000;

test.describe.serial("默认工作区", () => {
  // 冷内核（无 provider）首启会弹 onboarding 向导（modal-overlay）遮住侧栏点击，
  // 须先补一个 provider；同 fleet-same-agent / skills 等 spec 的既有做法。
  test.beforeAll(async () => {
    await ensureProvider();
  });

  test("侧栏渲染独立'默认'区 + 🏠 默认工作区", async ({ page }) => {
    await page.goto("/");
    // 等项目列表加载
    await page.waitForTimeout(2000);
    // 默认工作区渲染在项目列表顶部（UI 已改为无「默认」小标题，见 ProjectList.tsx 注释）
    await expect(page.getByText("默认工作区").first()).toBeVisible({ timeout: 5000 });
    // 普通项目分区有「项目」小标题，默认工作区独立于其外
    await expect(page.getByText("项目", { exact: true }).first()).toBeVisible({ timeout: 5000 });
  });

  test("点击默认工作区进新建会话页 + 下拉默认选中", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
    // 点默认工作区
    await page.getByText("默认工作区").first().click();
    // 进入 new-session 视图
    await expect(page.getByTestId("new-session-pane")).toBeVisible({ timeout: 5000 });
    // 项目下拉默认选中 __system__
    const select = page.getByTestId("project-select");
    await expect(select).toHaveValue("__system__", { timeout: 5000 });
    // 选中 option 文本是 "🏠 默认工作区"（不含 cwd）
    const selectedOption = await select.locator("option:checked").textContent();
    expect(selectedOption).toContain("默认工作区");
    expect(selectedOption).toContain("🏠");
  });

  test("默认工作区右键菜单不含'删除项目'", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);
    // 右键默认工作区项目名
    await page.getByText("默认工作区").first().click({ button: "right" });
    // 等菜单出现
    await expect(page.getByTestId("project-context-menu")).toBeVisible({ timeout: 2000 });
    // 「在文件管理器中打开」入口应该存在
    await expect(page.getByTestId("menu-open-dir")).toBeVisible();
    // "删除项目" 不应该存在
    await expect(page.getByTestId("menu-delete-project")).toHaveCount(0);
  });

  test("默认工作区新建会话产生 workdir/<createdAt>/ 子目录", async ({ page }) => {
    await page.goto("/");
    await page.waitForTimeout(2000);

    // 通过 REST 创建一个默认工作区会话（绕过真实 LLM 调用）
    const session = await createSessionViaPrompt("__system__", {
      agentName: "dev",
      text: "e2e 测试",
      model: "test-model",  // 会失败但不影响 session 创建
    });

    expect(session).toBeTruthy();
    expect(session.projectId).toBe("__system__");
    expect(typeof session.createdAt).toBe("number");

    // 子目录应该在磁盘上存在
    // 注意：E2E kernel 的 WA_PI_DIR=E2E_WA_PI_DIR，所以子目录在 E2E_WA_PI_DIR/workdir/<createdAt>/
    const subDir = join(E2E_WA_PI_DIR, "workdir", String(session.createdAt));
    expect(existsSync(subDir)).toBe(true);

    // 清理：删掉这个测试产生的子目录。
    // 关键：默认工作区会话的 pi rpc 子进程以 workdir/<createdAt> 为 cwd 并被 kernel 保活，
    // Windows 下进程存活期间其 cwd 目录不可删除（EBUSY；实测子进程退出后即可删）。
    // 故先删会话（kernel session:delete → disposeSession 拆进程释放句柄），再轮询重试删目录；
    // 仍删不掉也不致命：global-teardown 会把整个 E2E_WA_PI_DIR 删掉。
    await fetch(`${API}/api/sessions/${session.id}`, { method: "DELETE" }).catch(
      () => {},
    );
    const cleanupDeadline = Date.now() + 15_000;
    while (existsSync(subDir)) {
      try {
        rmSync(subDir, { recursive: true, force: true });
      } catch {
        // pi 进程尚未退出（句柄未释放），等下一轮
      }
      if (!existsSync(subDir) || Date.now() > cleanupDeadline) break;
      await new Promise((r) => setTimeout(r, 300));
    }
  });

  test("默认工作区会话的「项目文件」列出该会话真实工作目录的内容", async ({ page }) => {
    // 回归：默认工作区会话的 cwd 由 session.createdAt 推导（workdir/<createdAt>）。
    // 前端乐观建会话用本地 Date.now()、内核收到 prompt 后自己再取一次并据此建目录，
    // 两者恒差几毫秒。若 addSession 同 id 去重时丢弃内核记录，文件树会去请求一个
    // 不存在的目录 → 面板恒空白（且 5s 轮询不自愈）。
    await page.goto("/");
    await page.waitForTimeout(1000);

    // 预置供应商让发送按钮可用（模型调用本身会失败，不影响会话创建与目录落地）
    await saveProvider({
      id: "e2e-defaultws-provider",
      name: "E2E DefaultWS",
      slug: "e2e-defaultws",
      baseUrl: "http://localhost:9999/v1",
      apiKey: "sk-e2e",
      api: "openai-completions",
      models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
    });

    // 从 UI 新建本工作区会话（走 NewSessionPane 的乐观建会话路径）
    await page.getByText("默认工作区").first().click();
    await expect(page.getByTestId("new-session-pane")).toBeVisible({ timeout: 5000 });
    await page.getByTestId("model-selector").selectOption({ label: "E2E DefaultWS/model-a" });
    const title = "explorer-dir-" + Math.random().toString(36).slice(2, 8);
    await page.locator('[data-testid="composer-input"] [role="textbox"]').fill(title);
    await page.getByTestId("composer-send").click();
    await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 5000 });

    // 内核记录的 createdAt 即真实工作目录名
    const sid = await page
      .locator(`aside [data-testid^="session-"]:has-text("${title}")`)
      .first()
      .getAttribute("data-testid")
      .then((v) => v?.replace("session-", "") ?? "");
    expect(sid).not.toBe("");
    const list = await fetch(`${API}/api/projects`).then((r) => r.json());
    const session = (list.sessions ?? []).find((s: any) => s.id === sid);
    expect(session).toBeTruthy();
    const dir = join(E2E_WA_PI_DIR, "workdir", String(session.createdAt));
    expect(existsSync(dir)).toBe(true);

    // 往真实工作目录写标记文件，文件树面板必须能列出来
    const marker = `marker-${Date.now()}.txt`;
    writeFileSync(join(dir, marker), "hello", "utf8");

    await page.getByTestId("btn-explorer").click();
    await expect(page.getByTestId("explorer-aside")).toBeVisible({ timeout: 5000 });
    // 面板若按错误目录（前端乐观时间戳）请求，会回 fs:error 且被当作空目录 → 恒空白
    await expect(page.getByText(marker, { exact: true })).toBeVisible({ timeout: 10000 });

    // 清理：先删会话（拆进程释放 cwd 句柄），再删目录
    await fetch(`${API}/api/sessions/${sid}`, { method: "DELETE" }).catch(() => {});
    const deadline = Date.now() + 10_000;
    while (existsSync(dir) && Date.now() < deadline) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        await new Promise((r) => setTimeout(r, 300));
      }
    }
  });

  test("默认工作区会话删除后保留子目录 + 7 天后被清理", async ({ page }) => {
    // 本测试验证清理任务逻辑——通过手动 utimes 子目录 mtime 模拟过期
    // 由于 cleanup 任务是 setInterval 每天跑一次，测试用 utimes 改 mtime 后
    // 直接调 page.evaluate 触发一次清理（需要 kernel 暴露 debug endpoint，当前未暴露）
    // 简化：只验证 workdir-cleaner 的逻辑（已被单元测试覆盖），此处跳过真实清理触发
    // 清理任务真实触发需要 kernel debug endpoint 或重启；单元测试 packages/kernel/tests/workdir-cleaner.test.ts
    // 已覆盖三重防护逻辑。手动验证：把任一 workdir/<ts>/ 子目录的 mtime 改为 8 天前，
    // 然后重启 kernel（启动时会跑一次 cleanupExpiredWorkdirs）即可看到该子目录被清理
    test.skip(true, "清理任务真实触发需要 kernel 重启，由开发者手动验证（见注释）");
  });

});

// 测试完成后清理所有截图（AGENTS.md 第 6 条要求）
test.afterAll(async () => {
  // Playwright 默认截图在 test-results/ 或 playwright-report/ 下
  // 由 global-teardown.ts 统一清理，这里不重复
});
