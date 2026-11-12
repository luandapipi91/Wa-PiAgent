import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { E2E_WS_PORT } from "../playwright.config";
import {
  createAgent,
  createSessionViaPrompt,
  deleteAgentQuiet,
  ensureProvider,
  getAgentConfig,
  saveAgentConfig,
} from "./helpers";

// 智能体设置里的 MCP 工具开关 → 对话进程工具集的端到端验证。
//
// 两条链路缺一不可：
//   ① 受限白名单只放行勾选的**精确工具名**（不再整台服务器通配）：关掉单个工具后，
//      同服务器其它工具仍放行，被关掉的不再出现在 pi 进程的 `--tools` 里；
//   ② 保存配置后，该智能体的活跃会话被标记为待整进程重建：下一次对话（prompt 前的
//      ensureStarted）用新工具集重新拉起 pi 进程——只改盘上配置不重建进程的话，
//      旧进程仍握着启动时的 --tools，开关形同虚设。
//
// 证据取自**真实 pi 子进程的命令行**（`--name <agent>-<sessionId 前 8 位>` 定位）：
// E2E 没有真实 provider（模型不会真的去调工具），但白名单是 spawn 参数，进程命令行
// 就是「这一次对话里 agent 实际拿到的工具集」。
const FIXTURE = join(process.cwd(), "e2e", "fixtures", "poc-mcp-server.mjs");
const SERVER = "e2e-tools"; // direct 曝光；pi 把 server 名 sanitize 成 e2e_tools → mcp__e2e_tools__*
const TOOL_PREFIX = "mcp__e2e_tools__";
// codemode 曝光（pi 缺省档位）：工具不直接声明给模型，只能由 codemode 脚本调到——
// 「关掉的工具还能被调用」在这个档位下最容易发生（白名单必须真的不注册它）
const CM_SERVER = "e2e-cm";
const CM_PREFIX = "mcp__e2e_cm__";
const CM_AGENT = "e2e-mcp-cm-ctl";
const AGENT = "e2e-mcp-ctl";
const PROJECT_ID = "e2e-proj-1";
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

/**
 * 该会话的 pi 进程 `--tools` 白名单；进程不存在返回 null，存在但没有 --tools（全放行）返回 []。
 *
 * marker 用 `--name <agent>-<sid 前 8 位>`（AgentManager 的命名规则），会话 id 前 8 位
 * 在用例里随机生成，避免与其它 spec 的进程串台。
 */
function piToolArgs(agent: string, sessionId: string): string[] | null {
  const marker = `--name ${agent}-${sessionId.slice(0, 8)}`;
  const out = execFileSync("ps", ["-eww", "-o", "args="], {
    encoding: "utf8",
    maxBuffer: 8 << 20,
  });
  const line = out.split("\n").find((l) => l.includes(marker));
  if (!line) return null;
  const m = line.match(/--tools\s+(\S+)/);
  return m ? m[1].split(",") : [];
}

/** 等会话这一轮结束（假 provider 会报错，但 turn 会收尾） */
async function waitTurnIdle(sessionId: string) {
  await expect
    .poll(
      async () => {
        const data = await api("GET", `/api/sessions/${sessionId}/messages`);
        return data.isActive === false;
      },
      { timeout: 60_000 },
    )
    .toBe(true);
}

/** 打开智能体配置弹窗 */
async function openAgentConfig(page: Page, agent: string) {
  await page.goto("/");
  await page.getByTestId("agent-collapsed").click();
  await expect(page.getByTestId("agent-gallery")).toBeVisible({ timeout: 10_000 });
  await page.getByTestId(`gallery-card-${agent}`).click({ button: "right" });
  await page.getByTestId("gallery-ctx-edit").click();
  await expect(page.getByTestId("agent-config")).toBeVisible({ timeout: 10_000 });
}

test.describe.serial("智能体 MCP 工具开关 → 对话工具集", () => {
  test.beforeAll(async () => {
    // 预置假 provider 规避首启 onboarding 向导（modal overlay 拦截点击）
    await ensureProvider();
    // 夹具 server ×2：真 stdio MCP（echo/ping）。direct 曝光 → 工具直接声明给模型；
    // codemode 曝光 → 工具只能由 codemode 脚本调到（覆盖「codemode 下关掉仍可调用」场景）
    await api("POST", "/api/mcp", {
      config: { name: SERVER, command: "bun", args: [FIXTURE], exposure: "direct" },
    });
    await api("POST", "/api/mcp", {
      config: { name: CM_SERVER, command: "bun", args: [FIXTURE], exposure: "codemode" },
    });
    // 等 pi 真连上、工具进 kernel 的枚举清单（AgentConfig 的 MCP tab 与白名单都依赖它）
    await expect
      .poll(
        async () => {
          const { tools } = await api("GET", "/api/agents/tools");
          const names = (tools ?? []).map((t: any) => t.name);
          return (
            names.includes(`${TOOL_PREFIX}echo`) &&
            names.includes(`${TOOL_PREFIX}ping`) &&
            names.includes(`${CM_PREFIX}echo`) &&
            names.includes(`${CM_PREFIX}ping`)
          );
        },
        { timeout: 120_000 },
      )
      .toBe(true);
  });

  test.afterAll(async () => {
    await deleteAgentQuiet(AGENT);
    await deleteAgentQuiet(CM_AGENT);
    await api("DELETE", `/api/mcp/${SERVER}`).catch(() => {});
    await api("DELETE", `/api/mcp/${CM_SERVER}`).catch(() => {});
  });

  test("关闭单个 MCP 工具后，下一次对话的 pi 进程不再放行它（同服务器其它工具仍在）", async ({
    page,
  }) => {
    test.skip(process.platform === "win32", "进程命令行断言仅覆盖 macOS / Linux");
    test.setTimeout(180_000);

    // 建一次性智能体，初始白名单显式勾上 echo + ping（不含整台服务器通配）
    await createAgent(AGENT);
    const cfg = await getAgentConfig(AGENT);
    await saveAgentConfig(AGENT, {
      ...cfg,
      tools: ["read", `${TOOL_PREFIX}echo`, `${TOOL_PREFIX}ping`],
    });

    // ① 第一次对话：两个工具都在——先证明「勾选的确实放行」
    const sessionId = "s-" + Math.random().toString(36).slice(2, 10);
    await createSessionViaPrompt(PROJECT_ID, {
      agentName: AGENT,
      text: "e2e mcp tools",
      sessionId,
    });
    await expect
      .poll(() => piToolArgs(AGENT, sessionId), { timeout: 90_000 })
      .not.toBeNull();
    const before = piToolArgs(AGENT, sessionId)!;
    expect(before).toContain(`${TOOL_PREFIX}echo`);
    expect(before).toContain(`${TOOL_PREFIX}ping`);
    expect(before).not.toContain(`${TOOL_PREFIX}*`);

    // ② GUI 关掉 echo（同组 ping 保持开）并保存
    await openAgentConfig(page, AGENT);
    await page.getByTestId("tab-mcp").click();
    await page.getByTestId("mcp-group-toggle-e2e_tools").click();
    const echoSwitch = page.getByTestId(`tool-switch-${TOOL_PREFIX}echo`);
    await expect(echoSwitch).toHaveAttribute("data-on", "true");
    await echoSwitch.click();
    await expect(echoSwitch).toHaveAttribute("data-on", "false");
    await expect(page.getByTestId(`tool-switch-${TOOL_PREFIX}ping`)).toHaveAttribute(
      "data-on",
      "true",
    );
    await page.getByTestId("cfg-save").click();
    await expect(page.getByTestId("agent-config")).toHaveCount(0, { timeout: 10_000 });

    // 盘上配置确实只剩 ping 的勾选（排除「只改了界面没落盘」的假象）
    await expect
      .poll(
        async () => {
          const saved = (await getAgentConfig(AGENT))?.tools ?? [];
          return Array.isArray(saved) && !saved.includes(`${TOOL_PREFIX}echo`);
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    const savedTools: string[] = (await getAgentConfig(AGENT))?.tools ?? [];
    expect(savedTools).toContain(`${TOOL_PREFIX}ping`);

    // ③ 第二次对话：保存后活跃会话被标记重建，新进程的 --tools 不再有 echo
    await waitTurnIdle(sessionId);
    await createSessionViaPrompt(PROJECT_ID, {
      agentName: AGENT,
      text: "e2e mcp tools again",
      sessionId,
    });
    await expect
      .poll(
        () => {
          const args = piToolArgs(AGENT, sessionId);
          return args && !args.includes(`${TOOL_PREFIX}echo`) ? args.join(",") : null;
        },
        { timeout: 90_000 },
      )
      .toBeTruthy();
    const after = piToolArgs(AGENT, sessionId)!;
    expect(after).not.toContain(`${TOOL_PREFIX}echo`);
    expect(after).toContain(`${TOOL_PREFIX}ping`);
  });

  test("codemode 曝光：白名单只放行勾选的精确工具 + codemode 入口（未勾选的不进 --tools）", async () => {
    test.skip(process.platform === "win32", "进程命令行断言仅覆盖 macOS / Linux");
    test.setTimeout(180_000);

    // 只勾 echo：ping 必须被挡在 pi 的注册表之外，否则 codemode 的 tools.* 仍能调到它
    await createAgent(CM_AGENT);
    const cfg = await getAgentConfig(CM_AGENT);
    await saveAgentConfig(CM_AGENT, {
      ...cfg,
      tools: ["read", `${CM_PREFIX}echo`],
    });

    const sessionId = "s-" + Math.random().toString(36).slice(2, 10);
    await createSessionViaPrompt(PROJECT_ID, {
      agentName: CM_AGENT,
      text: "e2e codemode tools",
      sessionId,
    });
    await expect
      .poll(() => piToolArgs(CM_AGENT, sessionId), { timeout: 120_000 })
      .not.toBeNull();
    const tools = piToolArgs(CM_AGENT, sessionId)!;
    // 勾选的精确名 + codemode 入口（非 direct 工具的唯一到达通道）
    expect(tools).toContain(`${CM_PREFIX}echo`);
    expect(tools).toContain("codemode");
    // 同服务器未勾选的工具不放行，也不整台服务器通配
    expect(tools).not.toContain(`${CM_PREFIX}ping`);
    expect(tools).not.toContain(`${CM_PREFIX}*`);
  });
});
