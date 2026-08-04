import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { E2E_WS_PORT } from "../playwright.config";
import { createProject, saveProvider, createSessionViaPrompt } from "./helpers";

// ext-ui-bridge-demo 本地扩展 E2E（回归两个修复 + 对话子协议）：
// 1. local 路径安装后身份统一为 package.json name：插件列表展示 ext-ui-bridge-demo，
//    命令扫描 packageName 同名 →「附加命令」弹窗能扫到 /uidemo（此前按绝对路径过滤恒为空）。
// 2. 会话中发送已注册扩展命令 /uidemo：pi 拦截直接执行 handler（notify 系统提示出现），
//    不作为用户消息上屏（跟随 TUI 行为：命令被拦截执行，不进聊天列表）。
// 3. dialog 子协议：/uidemo select 弹 ExtensionDialog，应答后 handler notify 回显结果。
//
// 依赖真实 pi 进程（本地扩展经 -e 加载），按 PI_E2E=1 门控，CI 默认跳过。
// 截图清理：本 spec 不落盘任何截图/临时文件。

const DEMO_DIR = join(process.cwd(), "..", "..", "examples", "ext-ui-bridge-demo");
const PKG = "ext-ui-bridge-demo"; // demo package.json 的 name（身份统一后的展示名/过滤键）

const BASE = `http://127.0.0.1:${E2E_WS_PORT}`;

async function apiPost(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`REST POST ${path} 失败(${res.status}): ${data?.error ?? res.status}`);
  return data;
}

async function apiGet(path: string) {
  const res = await fetch(`${BASE}${path}`);
  return res.json().catch(() => ({}));
}

test.describe.serial("ext-ui-bridge-demo 本地扩展", () => {
  let projectId = "";
  let projectName = "";

  test.beforeAll(async () => {
    test.skip(!process.env.PI_E2E, "需真实 Pi 环境（PI_E2E=1 启用）");
    projectName = `e2e-uidemo-${randomUUID().slice(0, 8)}`;
    const project = await createProject(projectName, `/tmp/${projectName}`);
    projectId = project.id;
    await saveProvider({
      id: "e2e-uidemo-provider",
      name: "E2E UIDemo",
      slug: "e2e-uidemo",
      baseUrl: "http://localhost:9999/v1",
      apiKey: "sk-e2e",
      api: "openai-completions",
      models: [{ id: "model-a", contextWindow: 128000, maxTokens: 4096 }],
    });
    // 安装本地扩展（绝对路径；重复安装容错「已安装」）
    try {
      await apiPost("/api/extensions/install", { name: DEMO_DIR });
    } catch (e) {
      if (!String(e).includes("已安装")) throw e;
    }
  });

  // 建会话（经 prompt，触发 pi 进程启动并加载扩展），返回 sessionId。
  // 首条消息用扩展命令 "/uidemo title"：pi 直接执行 handler、不产生 LLM turn——
  // 避免假 provider 的「连接异常」失败轮让会话长时间 busy，把后续命令挤进
  // followUp 队列导致 notify 超过断言窗口（真实环境跑出过这个 flaky）。
  async function spawnSession(): Promise<string> {
    const sessionId = "s-e2e-uidemo-" + randomUUID().slice(0, 8);
    await createSessionViaPrompt(projectId, {
      agentName: "研发",
      text: "/uidemo title",
      model: "e2e-uidemo/model-a",
      sessionId,
    });
    return sessionId;
  }

  // 轮询命令清单直到出现目标命令（借用活跃 pi 进程）
  async function pollCommand(name: string, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const data: any = await apiGet("/api/extensions/commands");
      const cmd = (data?.commands ?? []).find((c: any) => c.name === name);
      if (cmd) return cmd;
      if (Date.now() > deadline) {
        throw new Error(`命令 ${name} 轮询超时: ${JSON.stringify(data?.commands)}`);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  test("local 安装后列表身份为包名，命令扫描 packageName 一致", async () => {
    // 插件列表：name 应为 package.json name（而非安装时的绝对路径）
    const exts: any = await apiGet("/api/extensions");
    const pkg = (exts?.packages ?? []).find((p: any) => p.name === PKG);
    expect(pkg, `插件列表应含 ${PKG}: ${JSON.stringify(exts?.packages)}`).toBeTruthy();
    expect(pkg.source).toBe("local");

    // 起会话进程后扫命令：uidemo 的 packageName 必须等于列表身份（弹窗过滤键）
    await spawnSession();
    const cmd = await pollCommand("uidemo");
    expect(cmd.packageName).toBe(PKG);
    expect(cmd.source).toBe("extension");
  });

  test("「附加命令」弹窗扫到 /uidemo", async ({ page }) => {
    await spawnSession(); // 保证有活跃进程供命令扫描借用
    await page.goto("/");
    await page.getByTestId("settings-btn").click();
    await expect(page.getByTestId("settings-modal")).toBeVisible();
    await page.getByRole("button", { name: "插件", exact: true }).click();
    // 插件卡片以包名展示（testid 含包名而非路径）
    await expect(page.getByTestId(`ext-card-${PKG}`)).toBeVisible({ timeout: 30_000 });
    await page.getByTestId(`ext-commands-${PKG}`).click();
    await expect(page.getByTestId("command-list-modal")).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("cmd-row-uidemo")).toBeVisible({ timeout: 20_000 });
  });

  test("发送 /uidemo 不出现用户消息气泡，命令确实执行", async ({ page }) => {
    const sessionId = await spawnSession();
    await page.goto("/");
    await page.waitForTimeout(500);
    await page.getByText(projectName).first().click();
    await page.getByTestId(`session-${sessionId}`).click();
    await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 8000 });

    // 选模型（composer 发送前置条件）
    await page.getByTestId("model-selector").selectOption({ label: "E2E UIDemo/model-a" });

    // / 菜单应能搜到 uidemo（命令清单已含扩展命令），同时确认前端 commands store 就绪
    const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');
    await textbox.click();
    await textbox.pressSequentially("/uidemo");
    await expect(page.getByText("uidemo").first()).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Escape");

    await textbox.fill("/uidemo notify");
    await page.keyboard.press("Escape"); // 收起 / 菜单，避免干扰发送
    await page.getByTestId("composer-send").click();

    // 正向控制：命令确实被 pi 拦截执行（handler 的 ctx.ui.notify 桥接为系统提示）
    await expect(
      page.locator('[data-testid^="custom-"]:has-text("手动 notify")').first(),
    ).toBeVisible({ timeout: 20_000 });

    // 核心断言：pi 拦截执行的扩展命令不作为用户消息上屏（跟随 TUI 行为）
    await expect(page.getByText("/uidemo notify")).toHaveCount(0);
  });

  test("内置插件命令（/mcp，pi-mcp-adapter）同样不出现用户消息气泡", async ({ page }) => {
    const sessionId = await spawnSession();
    await page.goto("/");
    await page.waitForTimeout(500);
    await page.getByText(projectName).first().click();
    await page.getByTestId(`session-${sessionId}`).click();
    await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 8000 });
    await page.getByTestId("model-selector").selectOption({ label: "E2E UIDemo/model-a" });

    // 确认 /mcp 已在命令清单（内置 PKG_EXTENSIONS 加载，source=extension）
    await pollCommand("mcp");

    const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');
    await textbox.click();
    await textbox.fill("/mcp");
    await page.keyboard.press("Escape");
    await page.getByTestId("composer-send").click();

    // 等一小段时间让潜在的回显/命令副作用落地，再断言无用户气泡
    await page.waitForTimeout(3000);
    await expect(page.getByText("/mcp")).toHaveCount(0);
  });

  test("扩展 dialog 子协议：/uidemo select 弹窗应答后 notify 回显结果", async ({ page }) => {
    const sessionId = await spawnSession();
    await page.goto("/");
    await page.waitForTimeout(500);
    await page.getByText(projectName).first().click();
    await page.getByTestId(`session-${sessionId}`).click();
    await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 8000 });
    await page.getByTestId("model-selector").selectOption({ label: "E2E UIDemo/model-a" });

    const textbox = page.locator('[data-testid="composer-input"] [role="textbox"]');
    await textbox.fill("/uidemo select");
    await page.keyboard.press("Escape");
    await page.getByTestId("composer-send").click();
    // 弹窗出现并应答
    await expect(page.getByText("demo select：选一个")).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "乙", exact: true }).click();
    // handler 收到应答并 notify 结果
    await expect(
      page.locator('[data-testid^="custom-"]:has-text("select 结果: 乙")').first(),
    ).toBeVisible({ timeout: 20_000 });
  });
});
