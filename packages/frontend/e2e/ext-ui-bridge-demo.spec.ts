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

const DEMO_DIR = join(
  process.cwd(),
  "..",
  "..",
  "examples",
  "ext-ui-bridge-demo",
);
const PKG = "ext-ui-bridge-demo"; // demo package.json 的 name（身份统一后的展示名/过滤键）

const BASE = `http://127.0.0.1:${E2E_WS_PORT}`;

async function apiPost(path: string, body: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(
      `REST POST ${path} 失败(${res.status}): ${data?.error ?? res.status}`,
    );
  return data;
}

async function apiGet(path: string) {
  const res = await fetch(`${BASE}${path}`);
  return res.json().catch(() => ({}));
}

test.describe
  .serial("ext-ui-bridge-demo 本地扩展", () => {
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
          throw new Error(
            `命令 ${name} 轮询超时: ${JSON.stringify(data?.commands)}`,
          );
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    test("local 安装后列表身份为包名，命令扫描 packageName 一致", async () => {
      // 插件列表：name 应为 package.json name（而非安装时的绝对路径）
      const exts: any = await apiGet("/api/extensions");
      const pkg = (exts?.packages ?? []).find((p: any) => p.name === PKG);
      expect(
        pkg,
        `插件列表应含 ${PKG}: ${JSON.stringify(exts?.packages)}`,
      ).toBeTruthy();
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
      await expect(page.getByTestId(`ext-card-${PKG}`)).toBeVisible({
        timeout: 30_000,
      });
      await page.getByTestId(`ext-commands-${PKG}`).click();
      await expect(page.getByTestId("command-list-modal")).toBeVisible({
        timeout: 5000,
      });
      await expect(page.getByTestId("cmd-row-uidemo")).toBeVisible({
        timeout: 20_000,
      });
    });

    test("发送 /uidemo 不出现用户消息气泡，命令确实执行", async ({ page }) => {
      const sessionId = await spawnSession();
      await page.goto("/");
      await page.waitForTimeout(500);
      await page.getByText(projectName).first().click();
      await page.getByTestId(`session-${sessionId}`).click();
      await expect(page.getByTestId("session-view")).toBeVisible({
        timeout: 8000,
      });

      // 选模型（composer 发送前置条件）
      await page
        .getByTestId("model-selector")
        .selectOption({ label: "E2E UIDemo/model-a" });

      // / 菜单应能搜到 uidemo（命令清单已含扩展命令），同时确认前端 commands store 就绪
      const textbox = page.locator(
        '[data-testid="composer-input"] [role="textbox"]',
      );
      await textbox.click();
      await textbox.pressSequentially("/uidemo");
      await expect(page.getByText("uidemo").first()).toBeVisible({
        timeout: 15_000,
      });
      await page.keyboard.press("Escape");

      await textbox.fill("/uidemo notify");
      await page.keyboard.press("Escape"); // 收起 / 菜单，避免干扰发送
      await page.getByTestId("composer-send").click();

      // 正向控制：命令确实被 pi 拦截执行（handler 的 ctx.ui.notify 桥接为系统提示）
      await expect(
        page
          .locator('[data-testid^="custom-"]:has-text("手动 notify")')
          .first(),
      ).toBeVisible({ timeout: 20_000 });

      // 核心断言：pi 拦截执行的扩展命令不作为用户消息上屏（跟随 TUI 行为）
      await expect(page.getByText("/uidemo notify")).toHaveCount(0);
    });

    test("内置 pi 命令（/mcp）：不在「附加命令」清单里，发送后也不出现用户消息气泡", async ({
      page,
    }) => {
      const sessionId = await spawnSession();
      await page.goto("/");
      await page.waitForTimeout(500);
      await page.getByText(projectName).first().click();
      await page.getByTestId(`session-${sessionId}`).click();
      await expect(page.getByTestId("session-view")).toBeVisible({
        timeout: 8000,
      });
      await page
        .getByTestId("model-selector")
        .selectOption({ label: "E2E UIDemo/model-a" });

      // 命令清单就绪的**确定性**前置：等本会话 pi 进程里真实存在的扩展命令出现
      //（uidemo 由 beforeAll 安装的本地扩展贡献）。这里不能用 pollCommand("mcp") 等：
      // 内置命令现在**预期不在清单里**，轮询必然超时；而本 describe 是 serial，
      // 一次超时会静默跳过后面 3 条用例（dialog 子协议 / notify ANSI / setStatus+setWidget）。
      await pollCommand("uidemo");
      // pi 内置扩展命令（/mcp、被禁用的 llama.cpp）不进「附加命令」清单：
      // kernel 的 tui-command-filter 给它们打 builtinExtension 标记，展示端点与前端 / 菜单
      // 各自过滤；但条目本身必须保留在 session:commands 里——回显抑制靠它判定
      //「pi 会不会拦截这条命令」，剔除会让聊天窗凭空多出一条并不存在的用户消息。
      const list: any = await apiGet("/api/extensions/commands");
      const names: string[] = (list?.commands ?? []).map((c: any) => c.name);
      expect(
        names,
        `命令清单不该含内置命令: ${JSON.stringify(names)}`,
      ).not.toContain("mcp");
      expect(names).not.toContain("llama");
      // 清单确实有内容，否则上面的 not.toContain 会平凡成立（空清单也能通过）
      expect(names).toContain("uidemo");

      const textbox = page.locator(
        '[data-testid="composer-input"] [role="textbox"]',
      );
      await textbox.click();
      await textbox.fill("/mcp");
      await page.keyboard.press("Escape");
      await page.getByTestId("composer-send").click();
      // 发送确实发生了（发送后输入框清空）——否则下面的「无气泡」会平凡成立
      await expect(textbox).toHaveText("");

      // 等一小段时间让潜在的回显/命令副作用落地，再断言无用户气泡
      await page.waitForTimeout(3000);
      // 前提核验（**不是**本回归的判别证据）：pi 确实把 `/mcp` 当命令拦截执行、不写 transcript，
      // 所以这里核验 transcript 里没有这条 user 消息。注意它在修前修后同样成立——假气泡只来自
      // 前端乐观插入 + kernel 的 session:echo_user，与 pi 的 transcript 无关，因此它判不出本次
      // 回归；真正有判别力的是下面那条 exact 匹配的气泡断言（报告 §3.6 的红跑反证）。
      const msgs: any = await apiGet(
        `/api/sessions/${encodeURIComponent(sessionId)}/messages`,
      );
      const userTexts: string[] = (msgs?.messages ?? [])
        .filter((m: any) => m.role === "user")
        .map((m: any) =>
          (m.content ?? [])
            .filter((b: any) => b.type === "text")
            .map((b: any) => b.text)
            .join(""),
        );
      expect(
        userTexts,
        `pi transcript 不该有 /mcp 用户消息: ${JSON.stringify(userTexts)}`,
      ).not.toContain("/mcp");
      // 用户气泡断言用 exact：pi 对 /mcp 的输出里带 `…\.pi/mcp.json` 路径，子串匹配会被它误命中
      //（旧实现写 pollCommand("mcp") 时 pi-mcp-adapter 的输出没有这个路径）。exact 匹配的
      // 恰好是用户气泡内层 <p> 的文本——假气泡（乐观插入而 pi 并未收到）会精确命中 "/mcp"。
      await expect(page.getByText("/mcp", { exact: true })).toHaveCount(0);
    });

    test("扩展 dialog 子协议：/uidemo select 弹窗应答后 notify 回显结果", async ({
      page,
    }) => {
      const sessionId = await spawnSession();
      await page.goto("/");
      await page.waitForTimeout(500);
      await page.getByText(projectName).first().click();
      await page.getByTestId(`session-${sessionId}`).click();
      await expect(page.getByTestId("session-view")).toBeVisible({
        timeout: 8000,
      });
      await page
        .getByTestId("model-selector")
        .selectOption({ label: "E2E UIDemo/model-a" });

      const textbox = page.locator(
        '[data-testid="composer-input"] [role="textbox"]',
      );
      await textbox.fill("/uidemo select");
      await page.keyboard.press("Escape");
      await page.getByTestId("composer-send").click();
      // 弹窗出现并应答
      await expect(page.getByText("demo select：选一个")).toBeVisible({
        timeout: 20_000,
      });
      await page.getByRole("button", { name: "乙", exact: true }).click();
      // handler 收到应答并 notify 结果
      await expect(
        page
          .locator('[data-testid^="custom-"]:has-text("select 结果: 乙")')
          .first(),
      ).toBeVisible({ timeout: 20_000 });
    });

    // Task 5：notify 永久保留 + ANSI 颜色解析全链路
    test("notify 消息永久保留且解析 ANSI 颜色", async ({ page }) => {
      const sessionId = await spawnSession();
      await page.goto("/");
      await page.waitForTimeout(500);
      await page.getByText(projectName).first().click();
      await page.getByTestId(`session-${sessionId}`).click();
      await expect(page.getByTestId("session-view")).toBeVisible({
        timeout: 8000,
      });
      await page
        .getByTestId("model-selector")
        .selectOption({ label: "E2E UIDemo/model-a" });

      const textbox = page.locator(
        '[data-testid="composer-input"] [role="textbox"]',
      );
      await textbox.fill("/uidemo color");
      await page.keyboard.press("Escape"); // 收起 / 菜单
      await page.getByTestId("composer-send").click();

      // notify 消息出现在聊天列表（带 ANSI 文本「橙色 notify」）
      const notify = page
        .locator('[data-testid^="custom-"]:has-text("橙色 notify")')
        .first();
      await expect(notify).toBeVisible({ timeout: 20_000 });

      // 10s 后仍在（不自动消退）
      await page.waitForTimeout(10_000);
      await expect(notify).toBeVisible();

      // 验证有内联颜色样式（AnsiText 解析 256 色为 span[style*="color"]）
      const coloredSpan = notify.locator('span[style*="color"]');
      await expect(coloredSpan.first()).toBeVisible();
    });

    test("setStatus/setWidget/setTitle ANSI 颜色渲染", async ({ page }) => {
      const sessionId = await spawnSession();
      await page.goto("/");
      await page.waitForTimeout(500);
      await page.getByText(projectName).first().click();
      await page.getByTestId(`session-${sessionId}`).click();
      await expect(page.getByTestId("session-view")).toBeVisible({
        timeout: 8000,
      });
      await page
        .getByTestId("model-selector")
        .selectOption({ label: "E2E UIDemo/model-a" });

      const textbox = page.locator(
        '[data-testid="composer-input"] [role="textbox"]',
      );
      await textbox.fill("/uidemo color");
      await page.keyboard.press("Escape");
      await page.getByTestId("composer-send").click();

      // widget 收起窄条可见（ui-demo-color-above，悬浮队列里的 chip）
      const chip = page.locator(
        '[data-testid="ext-widget-ui-demo-color-above"]',
      );
      await expect(chip).toBeVisible({ timeout: 20_000 });

      // 默认靠右：chip 队列整体贴着聊天列右侧（队列右缘不早于输入框右缘）
      const composerBox = (await page
        .getByTestId("composer-input")
        .boundingBox())!;
      const dockBefore = (await page
        .getByTestId("ext-widget-dock")
        .boundingBox())!;
      expect(dockBefore.x + dockBefore.width).toBeGreaterThanOrEqual(
        composerBox.x + composerBox.width - 2,
      );

      // 自由拖动：向左拖 80px 后队列整体平移，且位移写入 localStorage
      const chipBox = (await chip.boundingBox())!;
      const cx = chipBox.x + chipBox.width / 2;
      const cy = chipBox.y + chipBox.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx - 80, cy, { steps: 8 });
      await page.mouse.up();
      const dockAfter = (await page
        .getByTestId("ext-widget-dock")
        .boundingBox())!;
      expect(dockAfter.x).toBeLessThan(dockBefore.x - 40);
      const stored = await page.evaluate(() =>
        localStorage.getItem("wa-pi:ext-widget-dock-offset"),
      );
      expect(stored).toBeTruthy();
      expect(JSON.parse(stored as string).x).toBeLessThan(-40);
      // 清理：复位持久化位移，避免影响后续断言 / 重跑
      await page.evaluate(() =>
        localStorage.removeItem("wa-pi:ext-widget-dock-offset"),
      );

      // 点击 chip 展开 → testid 转移到展开块，查看彩色行
      await chip.click();
      const expanded = page.locator(
        '[data-testid="ext-widget-ui-demo-color-above"]',
      );
      await expect(expanded).toBeVisible({ timeout: 5000 });
      const coloredLine = expanded.locator('span[style*="color"]');
      await expect(coloredLine.first()).toBeVisible();
      // 回归：展开态头部不得把内部位置标识（aboveEditor/belowEditor）当文本渲染出来
      await expect(expanded).not.toContainText("aboveEditor");
      await expect(expanded).not.toContainText("belowEditor");
    });
  });
