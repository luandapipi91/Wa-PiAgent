import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { E2E_WS_PORT } from "../playwright.config";
import { createProject, saveProvider, createSessionViaPrompt } from "./helpers";

// Task 10: 插件命令级启停管理 E2E 测试
//
// 覆盖：
// 1. [需 pi 环境] 设置页打开插件命令弹窗（ext-commands-{pkg}）→ CommandListModal 显示 →
//    开启 /goal → / 菜单出现 /goal
// 2. [需 pi 环境] 关闭 /goal → / 菜单消失 → 手动输入 /goal xxx 发送 → LLM 收到普通文本
//    （断言无命令执行副作用：不出现 extension_notify 系统提示）
// 3. extension_notify 系统消息 → 20s 后自动从聊天列表消失（纯前端 UI 行为，始终运行）
//
// 约定：
// - 场景 1/2 依赖真实 pi 进程 + 真实 npm 安装的插件（pi-goal）+ 真实 LLM；隔离 E2E 环境
//   （~/.wa-pi-e2e）不预置任何插件，按 intercom.spec.ts 模式用 PI_E2E=1 条件跳过，不阻塞 CI。
// - beforeEach 复用 quick-invoke.spec.ts 的隔离项目模式（REST 建项目 + 预置 provider，
//   provider 固定 id/slug 每次覆盖写入，避免 selectOption 撞 label——composer.spec.ts 同款）。
// - 会话通过 createSessionViaPrompt REST 创建（绕过真实 LLM，explorer.spec.ts 同款），
//   前端侧栏点项目名 + 会话行进入 session 视图。
// - / 命令菜单即 ComposerInput 的 QuickInvokeMenu（detectTrigger "/" → type "command"）。
// - 场景 3 通过 events.ts 的 emitEventForTesting 注入 sdk:event(extension_notify)，走与真实
//   SSE 相同的分发路径（App.tsx onMessage → session store handleSDKEvent）。
// - 截图清理：本 spec 不落盘任何截图/临时文件（test-results/ 由 .gitignore 忽略）。

const PI_PKG = "@narumitw/pi-goal"; // pi-goal 裸包名（全链路统一）
const PI_CMD = "goal"; // /goal 命令名（cmd.name，无斜杠前缀）

test.describe.serial("插件命令级启停管理", () => {
  let projectId = "";
  let projectName = "";

  test.beforeEach(async () => {
    projectName = `e2e-command-toggles-${randomUUID().slice(0, 8)}`;
    const project = await createProject(projectName, `/tmp/${projectName}`);
    projectId = project.id;

    // 预置模型供应商（固定 id/slug，每次覆盖写入同一 provider，避免全量跑时 label 撞车）
    await saveProvider({
      id: "e2e-command-toggles-provider",
      name: "E2E Toggles",
      slug: "e2e-command-toggles",
      baseUrl: "http://localhost:9999/v1",
      apiKey: "sk-e2e",
      api: "openai-completions",
      models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
    });
  });

  // 打开设置 → 插件标签（settings-modal 的插件 nav 无 testid，按按钮文本精确匹配）
  async function openSettingsPlugins(page: import("@playwright/test").Page) {
    await expect(page.getByTestId("settings-btn")).toBeVisible({ timeout: 8000 });
    await page.getByTestId("settings-btn").click();
    await expect(page.getByTestId("settings-modal")).toBeVisible();
    await page.getByRole("button", { name: "插件", exact: true }).click();
    await expect(page.getByTestId("ext-install-input")).toBeVisible();
  }

  // 设置页 → 插件 → 打开指定包的「附加命令」弹窗（CommandListModal）
  async function openCommandModal(page: import("@playwright/test").Page, pkg: string) {
    await openSettingsPlugins(page);
    await expect(page.getByTestId(`ext-card-${pkg}`)).toBeVisible({ timeout: 30_000 });
    await page.getByTestId(`ext-commands-${pkg}`).click();
    await expect(page.getByTestId("command-list-modal")).toBeVisible({ timeout: 5000 });
  }

  // 进入会话视图（REST 建会话 → 侧栏点项目名 → 点会话行，explorer.spec.ts 同款）
  async function enterSession(page: import("@playwright/test").Page, text: string): Promise<string> {
    await page.goto("/");
    await page.waitForTimeout(500); // 等侧栏会话列表挂载
    const sessionId = "s-e2e-cmdtog-" + randomUUID().slice(0, 8);
    await createSessionViaPrompt(projectId, {
      agentName: "dev",
      text,
      model: "e2e-command-toggles/model-a",
      sessionId,
    });
    await page.getByText(projectName).first().click();
    await page.getByTestId(`session-${sessionId}`).click();
    await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 8000 });
    return sessionId;
  }

  // REST 直接设置命令开关（幂等；用于场景起点复位，保证用例从确定状态开始）
  async function setCommandToggle(pkg: string, command: string, enabled: boolean) {
    const res = await fetch(`http://127.0.0.1:${E2E_WS_PORT}/api/extensions/commands/toggle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ packageName: pkg, command, enabled }),
    });
    if (!res.ok) throw new Error(`命令开关 REST 失败(${res.status}): ${await res.text()}`);
  }

  // 轮询 /api/extensions/commands 直到目标命令 enabled 达到期望值（REST 落盘确认）
  async function pollCommandEnabled(pkg: string, command: string, expected: boolean) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const res = await fetch(`http://127.0.0.1:${E2E_WS_PORT}/api/extensions/commands`);
      const data: any = await res.json().catch(() => ({}));
      const cmd = (data?.commands ?? []).find(
        (c: any) => c.packageName === pkg && c.name === command,
      );
      if (cmd && cmd.enabled === expected) return;
      if (Date.now() > deadline) {
        throw new Error(`命令 ${command} enabled=${expected} 轮询超时: ${JSON.stringify(cmd)}`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  // ── 场景 1/2：真实 pi 环境（PI_E2E=1 启用），CI 默认跳过 ──

  test("[需 pi 环境] 设置页开启 /goal 后 / 菜单出现 /goal", async ({ page }) => {
    test.skip(!process.env.PI_E2E, "需真实 Pi 环境（PI_E2E=1 启用）");

    // 起点复位：确保 /goal 从关闭状态开始
    await setCommandToggle(PI_PKG, PI_CMD, false);

    // 1. 设置页 → 插件 → pi-goal「附加命令」弹窗
    await openCommandModal(page, PI_PKG);

    // 2. CommandListModal 显示，/goal 行与开关可见
    await expect(page.getByTestId("cmd-row-goal")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("cmd-toggle-goal")).toBeVisible();
    await expect(page.getByTestId("cmd-row-goal")).toContainText("/goal");

    // 3. 开启 /goal（弹窗内点击开关，乐观翻转 + REST 落盘）
    await page.getByTestId("cmd-toggle-goal").click();
    await pollCommandEnabled(PI_PKG, PI_CMD, true);

    // 4. 关闭弹窗与设置页（Modal 支持 ESC 关闭）
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("command-list-modal")).toHaveCount(0, { timeout: 3000 });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings-modal")).toHaveCount(0, { timeout: 3000 });

    // 5. 进入会话，/ 菜单出现 /goal
    await enterSession(page, "开启 goal 命令测试");
    const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');
    await textbox.click();
    await page.keyboard.type("/", { delay: 5 });
    await expect(page.getByTestId("quick-invoke-menu")).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("quick-invoke-menu")).toContainText("goal", { timeout: 8000 });
  });

  test("[需 pi 环境] 关闭 /goal 后 / 菜单消失且发送为普通文本（无命令副作用）", async ({ page }) => {
    test.skip(!process.env.PI_E2E, "需真实 Pi 环境（PI_E2E=1 启用）");

    // 起点复位：确保 /goal 已开启，再走关闭流程
    await setCommandToggle(PI_PKG, PI_CMD, true);

    // 1. 设置页 → 插件 → pi-goal 命令弹窗 → 关闭 /goal
    await openCommandModal(page, PI_PKG);
    await expect(page.getByTestId("cmd-row-goal")).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("cmd-toggle-goal").click();
    await pollCommandEnabled(PI_PKG, PI_CMD, false);

    // 2. 关闭弹窗与设置页
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("command-list-modal")).toHaveCount(0, { timeout: 3000 });
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("settings-modal")).toHaveCount(0, { timeout: 3000 });

    // 3. / 菜单不再出现 /goal（commands store 过滤：extension 命令只显示 enabled === true）
    await enterSession(page, "关闭 goal 命令测试");
    const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');
    await textbox.click();
    await page.keyboard.type("/", { delay: 5 });
    await expect(page.getByTestId("quick-invoke-menu")).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("quick-invoke-menu")).not.toContainText("goal", { timeout: 8000 });

    // 4. 手动输入 /goal xxx 发送 → LLM 收到普通文本，无命令执行副作用。
    //    副作用信号：若 /goal 仍被识别为命令，pi 会经 ctx.ui.notify 回推 extension_notify
    //    系统提示（custom 消息）；关闭后不应出现，且用户消息原文以普通文本回显。
    //    （真实 LLM 回复内容不可控，只断言回显 + 无副作用提示；需 PI_E2E 环境配置真实 provider）
    await page.keyboard.press("Escape"); // 关闭 / 菜单，避免干扰发送
    await textbox.fill("/goal 写一个计划");
    await page.getByTestId("composer-send").click();
    await expect(page.getByText("/goal 写一个计划").first()).toBeVisible({ timeout: 8000 });
    await expect(
      page.locator('[data-testid^="custom-"]:has-text("goal")'),
    ).toHaveCount(0, { timeout: 15_000 });
  });

  // ── 场景 3：纯前端 UI 行为，隔离 E2E 环境可验证，始终运行 ──

  test("extension_notify 系统消息 20s 后自动从聊天列表消失", async ({ page }) => {
    test.setTimeout(60_000);
    await enterSession(page, "extension_notify 测试");

    const noticeText = "E2E 插件命令执行完成";

    // 注入 sdk:event(extension_notify)：等历史加载完成（避免 setMessages 覆盖注入消息），
    // 优先走 events 总线（emitEventForTesting，与真实 SSE 同分发路径），
    // 注入失败则兜底直连 session store 的 handleSDKEvent（与单测同路径）。
    await page.evaluate(
      async ({ projectId, sessionId, text }) => {
        const { useSessionStore } = await import("/src/store/session.ts");
        const deadline = Date.now() + 8000;
        while (useSessionStore.getState().historyLoadingBySession[sessionId]) {
          if (Date.now() > deadline) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        const envelope = {
          type: "sdk:event",
          projectId,
          sessionId,
          agentName: "dev",
          event: { type: "extension_notify", message: text },
        };
        try {
          const { emitEventForTesting } = await import("/src/events.ts");
          emitEventForTesting(envelope as any);
          const got = useSessionStore
            .getState()
            .messagesBySession[sessionId]?.some(
              (m: any) => (m.message as any)?.customType === "extension_notify",
            );
          if (!got) useSessionStore.getState().handleSDKEvent(sessionId, envelope as any);
        } catch {
          useSessionStore.getState().handleSDKEvent(sessionId, envelope as any);
        }
      },
      { projectId, sessionId, text: noticeText },
    );

    // 1. 注入后立即出现在聊天窗口（居中系统提示：—— 内容 ——）
    const notice = page.getByText(new RegExp(`—— ${noticeText} ——`));
    await expect(notice).toBeVisible({ timeout: 5000 });

    // 2. 20s 后自动消失（store 内 setTimeout(20_000) 按 timestamp 精确移除）
    await page.waitForTimeout(20_500);
    await expect(notice).toHaveCount(0, { timeout: 5000 });
  });
});
