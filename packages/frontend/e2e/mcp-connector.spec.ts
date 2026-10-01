import { test, expect, type Page } from "@playwright/test";
import { join } from "node:path";
import { E2E_WS_PORT } from "../playwright.config";
import { createSessionViaPrompt, ensureProvider } from "./helpers";

// 内置 MCP 端到端（迁移分支任务 13/14）。
//
// 两条能拿到的最强证据（控制者裁决 A：简报里「勾选 mcp__e2e__echo → 发消息 → 断言嵌套卡片」
// 在 E2E 里做不到——本仓 E2E 无真实 provider/凭证（见 channels.spec.ts:128），模型不会真的
// 去调工具，故拆成两半）：
//
//   ① 真实 pi 半边：经 GUI 表单添加夹具 server（`bun` 启动的最小 stdio MCP server，见
//      e2e/fixtures/poc-mcp-server.mjs，真 initialize/tools/list/tools/call）→ kernel 的
//      McpAdmin 真跑 `pi mcp list --json` 去连它 → `GET /api/mcp` 报 state=connected + tools；
//      GUI 卡片显示「已连接 · N 工具」；工具弹窗列出 echo/ping；agent 配置工具页可勾选
//      mcp__e2e__echo（枚举自 pi 已连服务器）；REST DELETE 后卡片消失。
//
//   ② 嵌套卡片半边：`window.__PI_E2E_EVENT__` 注入**与真实形状一致**的
//      `tool_execution_start/update/end`（toolCallId = "<父id>/1"、parentToolCallId = "<父id>"，
//      形状取自 POC 实测 F18，见 progress.md 的 T11 契约）驱动生产代码路径：
//      __PI_E2E_EVENT__ → events.dispatch → App onMessage 的 sdk:event 分支 →
//      sessionStore.handleSDKEvent → nestedCallsBySession → SessionView → MessageList →
//      ToolCallsSegment → 内层子卡（data-testid="toolcall-nested-item-<id>"）。
//      父卡（codemode）由同一路径注入的 assistant message_end 造出（toolCall 块），
//      子卡必须先不存在、注入后才出现，避免断言自造的假象。
//
// E2E kernel 由 global-setup 预置项目 "e2e-proj-1"（cwd=$WA_PI_DIR/e2e-project）与 agent "研发"（dev）。
//
// 耗时说明：每次 `pi mcp list` 都是真 spawn pi、真连服务器（McpAdmin 的冷路径），
// 单个用例因此给到 120s 预算（默认 30s 不够，实测卡片要 10~20s 才出现）。

const FIXTURE = join(process.cwd(), "e2e", "fixtures", "poc-mcp-server.mjs");
const SERVER = "e2e";
const BASE = `http://127.0.0.1:${E2E_WS_PORT}`;

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(
      `REST ${method} ${path} 失败(${res.status}): ${data?.error ?? JSON.stringify(data)}`,
    );
  }
  return data;
}

/** 取某作用域的清单条目（缺省全局） */
async function mcpEntry(name: string, projectId?: string) {
  const data = await api(
    "GET",
    projectId ? `/api/mcp?projectId=${encodeURIComponent(projectId)}` : "/api/mcp",
  );
  return (data.servers ?? []).find((s: any) => s.name === name);
}

/** 打开设置 → MCP 页 */
async function navigateToMcp(page: Page) {
  await expect(page.getByTestId("settings-btn")).toBeVisible({ timeout: 8000 });
  await page.getByTestId("settings-btn").click();
  await expect(page.getByTestId("settings-modal")).toBeVisible();
  await page.getByTestId("settings-nav-mcp").click();
  await expect(page.getByTestId("mcp-page")).toBeVisible();
}

/** 注入一帧服务端事件（与真实 SSE 帧走同一条 dispatch 主路径） */
async function emitSDK(page: Page, sessionId: string, event: unknown) {
  await page.evaluate(
    ({ sid, ev }) => {
      (window as any).__PI_E2E_EVENT__({
        type: "sdk:event",
        projectId: "e2e-proj-1",
        sessionId: sid,
        // 必须与会话的 primaryAgent 一致（隔离 env 的内置智能体是「研发」；用 "dev" 会报「原智能体已删除」）
        agentName: "研发",
        event: ev,
      });
    },
    { sid: sessionId, ev: event },
  );
}

test.describe.serial("MCP 连接器（pi 内置实现）", () => {
  test.beforeAll(async () => {
    // 预置假 provider 规避首启 onboarding 向导（modal overlay 拦截点击）
    await ensureProvider();
  });

  test.afterAll(async () => {
    // 清理：删掉本次添加的 server（失败忽略）。provider 留着给后续 spec 复用
    // （helpers.ensureProvider 的约定：返回 true 只表示「本次新建」，不必删）。
    await api("DELETE", `/api/mcp/${SERVER}`).catch(() => {});
  });

  test("GUI 表单添加夹具 server → pi 报 connected 且列出 echo/ping（真实 pi mcp list）", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.goto("/");
    await navigateToMcp(page);

    await page.getByTestId("mcp-add-button").click();
    await expect(page.getByTestId("mcp-form")).toBeVisible();
    await page.getByTestId("mcp-form-name").fill(SERVER);
    await page.getByTestId("mcp-form-command").fill("bun");
    // 夹具路径必须绝对：pi 起 server 的 cwd 是 agent 目录（全局作用域），相对路径找不到文件
    await page.getByTestId("mcp-form-args").fill(FIXTURE);
    await page.getByTestId("mcp-form-exposure").selectOption("direct");
    await page.getByTestId("mcp-form-save").click();

    // 卡片随后台广播 mcp:changed 出现；state 来自 pi 的 `pi mcp list --json`（真连夹具）
    await expect(page.getByTestId(`mcp-card-${SERVER}`)).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId(`mcp-state-${SERVER}`)).toHaveAttribute(
      "data-state",
      "connected",
      { timeout: 30_000 },
    );
    // 「已连接 · N 工具」的 N 来自 pi 报的 tools 长度
    await expect(page.getByTestId(`mcp-state-${SERVER}`)).toContainText("2");

    // REST 同源证据：清单条目的 state/tools/exposure 都是 pi 报的运行时事实
    const entry = await mcpEntry(SERVER);
    expect(entry, `GET /api/mcp 应有 ${SERVER}: ${JSON.stringify(entry)}`).toBeTruthy();
    expect(entry.state).toBe("connected");
    expect(entry.exposure).toBe("direct");
    expect([...entry.tools].sort()).toEqual(["echo", "ping"]);
  });

  test("相反控制：连不上的 server 不会被报成 connected（connected 断言非平凡）", async () => {
    test.setTimeout(120_000);
    const bogus = "e2e-bogus";
    await api("POST", "/api/mcp", {
      config: { name: bogus, command: "definitely-not-a-real-mcp-binary-xyz" },
    });
    try {
      const entry = await mcpEntry(bogus);
      expect(entry, `GET /api/mcp 应有 ${bogus}`).toBeTruthy();
      expect(entry.state).not.toBe("connected");
    } finally {
      await api("DELETE", `/api/mcp/${bogus}`).catch(() => {});
    }
  });

  test("工具弹窗列出 pi 报的工具名（echo/ping）", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/");
    await navigateToMcp(page);
    await page.getByTestId(`mcp-tools-${SERVER}`).click();
    const modal = page.getByTestId("mcp-tools-modal");
    await expect(modal).toBeVisible({ timeout: 20_000 });
    await expect(modal).toContainText("echo", { timeout: 20_000 });
    await expect(modal).toContainText("ping");
    // 只展示工具名（pi 的 list 不给描述/参数）：如实说明，不虚构字段
    await expect(page.getByTestId("mcp-tools-names-only")).toBeVisible();

    await modal.getByText("✕").click();
    await expect(modal).not.toBeVisible();
  });

  test("agent 配置工具页可勾选 mcp__e2e__echo（枚举自 pi 已连服务器）", async ({ page }) => {
    test.setTimeout(120_000);
    // kernel 侧枚举（listGlobalTools → McpAdmin → mcpToolNamesOf）
    const { tools } = await api("GET", "/api/agents/tools");
    const names = (tools ?? []).map((t: any) => t.name);
    expect(names).toContain("mcp__e2e__echo");
    expect(names).toContain("mcp__e2e__ping");
    expect(
      (tools ?? []).find((t: any) => t.name === "mcp__e2e__echo")?.source,
    ).toBe("MCP");

    // UI：智能体宫格 → 研发详情 → 工具 tab 有该开关（右键菜单进详情，与 agents.spec.ts 同路径）
    await page.goto("/");
    await page.getByTestId("agent-collapsed").click();
    await expect(page.getByTestId("agent-gallery")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("gallery-card-研发").click({ button: "right" });
    await page.getByTestId("gallery-ctx-edit").click();
    await expect(page.getByTestId("agent-config")).toBeVisible({ timeout: 10_000 });
    await page.getByTestId("tab-tools").click();
    await expect(page.getByTestId("tool-switch-mcp__e2e__echo")).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId("agent-config-close").click();
  });

  test("嵌套工具卡：注入 tool_execution_* 事件 → 内层子卡挂到父卡下（T11 实时链路）", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const parent = "call_e2e_codemode_1";
    const child = `${parent}/1`;

    // 建会话并进入会话页（父卡来自会话消息内容，需要一条会话上下文）。
    // agentName 用「研发」：隔离 e2e 环境的内置智能体（用 "dev" 会报「原智能体已删除」）。
    await page.goto("/");
    await page.waitForTimeout(2000);
    const session = await createSessionViaPrompt("e2e-proj-1", {
      agentName: "研发",
      text: "e2e",
      model: "test-model",
      sessionId: "s-e2e-nested-" + Math.random().toString(36).slice(2, 8),
    });
    await page.getByText("E2E项目").first().click();
    await page.getByTestId(`session-${session.id}`).click();
    await expect(page.getByTestId("session-view")).toBeVisible({ timeout: 8000 });
    await page.waitForTimeout(500);

    // 父调用：assistant 消息里的 toolCall 块（真实形状：pi 的 message_end 就是这一条）
    await emitSDK(page, session.id, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: parent,
            name: "codemode",
            arguments: {
              code: "const r = await tools.mcp__e2e__echo({ text: 'hi' })",
            },
          },
        ],
        model: "test-model",
        timestamp: Date.now(),
      },
    });

    // 已定稿回合的过程默认被 TurnSummary 折叠 → 展开（用户可见操作）；未折叠时无需点
    const summary = page.getByTestId("turn-summary").last();
    if ((await summary.count()) > 0) {
      await summary.click();
      await expect(summary).toHaveAttribute("aria-expanded", "true");
    }
    // 父卡（codemode）已经在列表里——它是注入子卡的前提
    await expect(page.getByText("codemode").first()).toBeVisible({
      timeout: 8000,
    });

    // 注入内层事件**之前**：没有任何嵌套卡（否则下面的断言就是在看自己造的假象）
    await expect(page.getByTestId(`toolcall-nested-${parent}`)).toHaveCount(0);
    await expect(page.getByTestId(`toolcall-nested-item-${child}`)).toHaveCount(0);

    // 反向控制：**不带** parentToolCallId 的平铺调用不进嵌套表——
    // 证明卡片确实由「事件形状 + store 的归并规则」决定，而不是「任何事件都变成子卡」
    await emitSDK(page, session.id, {
      type: "tool_execution_start",
      toolName: "bash",
      toolCallId: "call_flat_e2e_9",
      args: { command: "echo hi" },
    });
    await expect(page.getByTestId("toolcall-nested-call_flat_e2e_9")).toHaveCount(0);
    await expect(
      page.getByTestId("toolcall-nested-item-call_flat_e2e_9"),
    ).toHaveCount(0);

    // 内层调用开始（F18 形状：toolCallId = <父id>/N、带 parentToolCallId）
    await emitSDK(page, session.id, {
      type: "tool_execution_start",
      toolName: "mcp__e2e__echo",
      toolCallId: child,
      parentToolCallId: parent,
      args: { text: "hi" },
    });
    await expect(page.getByTestId(`toolcall-nested-${parent}`)).toBeVisible({
      timeout: 8000,
    });
    const item = page.getByTestId(`toolcall-nested-item-${child}`);
    await expect(item).toBeVisible({ timeout: 8000 });
    await expect(item).toHaveAttribute("data-status", "running");
    await expect(item).toContainText("mcp__e2e__echo");

    // 内层调用结束：终态与结果文本都来自 tool_execution_end（mergeNestedCall）
    await emitSDK(page, session.id, {
      type: "tool_execution_update",
      toolName: "mcp__e2e__echo",
      toolCallId: child,
      parentToolCallId: parent,
      args: { text: "hi" },
    });
    await emitSDK(page, session.id, {
      type: "tool_execution_end",
      toolName: "mcp__e2e__echo",
      toolCallId: child,
      parentToolCallId: parent,
      isError: false,
      result: {
        content: [{ type: "text", text: 'pong-poc:{"echo":"hi"}' }],
        details: { server: "e2e", tool: "echo" },
      },
    });
    await expect(item).toHaveAttribute("data-status", "ok", { timeout: 8000 });
    await expect(item).toContainText('pong-poc:{"echo":"hi"}');
  });

  test("编辑服务器：表单回填盘上配置，改名后卡片随新名更新（再改回）", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/");
    await navigateToMcp(page);

    await page.getByTestId(`mcp-edit-${SERVER}`).click();
    await expect(page.getByTestId("mcp-form")).toBeVisible();
    // 回填自盘上的 .pi/mcp.json（经 GET /api/mcp）
    await expect(page.getByTestId("mcp-form-name")).toHaveValue(SERVER);
    await expect(page.getByTestId("mcp-form-command")).toHaveValue("bun");
    await expect(page.getByTestId("mcp-form-args")).toHaveValue(FIXTURE);

    const renamed = `${SERVER}-renamed`;
    await page.getByTestId("mcp-form-name").fill(renamed);
    await page.getByTestId("mcp-form-save").click();
    await expect(page.getByTestId(`mcp-card-${renamed}`)).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId(`mcp-card-${SERVER}`)).toHaveCount(0);
    expect(await mcpEntry(renamed)).toBeTruthy();

    // 改回原名（后续用例依赖 e2e 这个名字）
    await page.getByTestId(`mcp-edit-${renamed}`).click();
    await page.getByTestId("mcp-form-name").fill(SERVER);
    await page.getByTestId("mcp-form-save").click();
    await expect(page.getByTestId(`mcp-card-${SERVER}`)).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByTestId(`mcp-card-${renamed}`)).toHaveCount(0);
  });

  test("项目作用域：切到项目后全局 server 不在列表，切回全局又出现", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/");
    await navigateToMcp(page);
    await expect(page.getByTestId(`mcp-card-${SERVER}`)).toBeVisible({ timeout: 20_000 });

    await page.getByTestId("mcp-scope-select").click();
    await expect(page.getByTestId("mcp-scope-menu")).toBeVisible();
    await page.getByTestId("mcp-scope-option-project-e2e-proj-1").click();
    // 项目作用域里没有配置任何 server（全局那份不得串台）
    await expect(page.getByTestId(`mcp-card-${SERVER}`)).toHaveCount(0);

    await page.getByTestId("mcp-scope-select").click();
    await page.getByTestId("mcp-scope-option-global").click();
    await expect(page.getByTestId(`mcp-card-${SERVER}`)).toBeVisible({ timeout: 20_000 });
  });

  test("删除服务器：确认弹窗后卡片消失，且 REST 清单里不再有它", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/");
    await navigateToMcp(page);
    await expect(page.getByTestId(`mcp-delete-${SERVER}`)).toBeVisible({
      timeout: 20_000,
    });

    await page.getByTestId(`mcp-delete-${SERVER}`).click();
    await expect(page.getByTestId("confirm-dialog")).toBeVisible();
    await page.getByTestId("confirm-ok").click();

    await expect(page.getByTestId(`mcp-card-${SERVER}`)).toHaveCount(0, {
      timeout: 20_000,
    });
    expect(await mcpEntry(SERVER)).toBeUndefined();
  });

  test("REST 添加 → connected → REST 删除 后卡片消失（无 GUI 的同一链路）", async ({ page }) => {
    test.setTimeout(120_000);
    await api("POST", "/api/mcp", {
      config: { name: SERVER, command: "bun", args: [FIXTURE], exposure: "direct" },
    });
    const entry = await mcpEntry(SERVER);
    expect(entry?.state).toBe("connected");
    expect([...(entry?.tools ?? [])].sort()).toEqual(["echo", "ping"]);

    await page.goto("/");
    await navigateToMcp(page);
    await expect(page.getByTestId(`mcp-card-${SERVER}`)).toBeVisible({ timeout: 20_000 });

    await api("DELETE", `/api/mcp/${SERVER}`);
    await expect(page.getByTestId(`mcp-card-${SERVER}`)).toHaveCount(0, {
      timeout: 20_000,
    });
    expect(await mcpEntry(SERVER)).toBeUndefined();
  });
});
