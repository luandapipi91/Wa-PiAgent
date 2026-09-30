/**
 * MCP 域路由（阶段二·去 WS 化）
 *
 * projectId 一律从 query 取（可选，缺省为全局作用域）；
 * serverName 在路径参数或 body 中，与前端 REST 调用约定一致。
 * mcp:save / mcp:delete 无 reply（case 内直接 broadcast mcp:changed → SSE 总线），
 * 故成功时响应 200 {ok:true}；mcp:test 的失败也走 mcp:testResult
 * reply（非 error 类型），HTTP 状态仍为 200，由 body.success 区分。
 */
import { join } from "node:path";
import { WA_PI_DIR, SYSTEM_PROJECT_ID, KernelError, toKernelPayload } from "@wa-pi/shared";
import type { ProjectStore } from "../project-store";
import { resolveCwdForFsRequest } from "../ws-server";
import { McpTrustStore } from "../mcp-trust";
import { migrateProjectMcpFile } from "../mcp-migrate";
import type { RouteContext, RouteRegistrar } from "./types";
import { readJsonBody, paramErrorResponse } from "./types";

/** pi 的 ProjectTrustStore(agentDir) 读的同一个文件：<WA_PI_DIR>/trust.json（F12/F13） */
function trustFilePath(): string {
  return join(process.env.WA_PI_DIR || WA_PI_DIR, "trust.json");
}

/**
 * 项目级 MCP 作用域开关的处理函数（对应端点 mcp:set-project-scope，规格 §5）。
 *
 * 为什么把「受信」落成 trust.json 而不是走扩展的 project_trust 事件：
 * 子代理是独立 pi 进程、不加载 bridge 扩展，只有 trust.json 对它们同样生效（F12）。
 *
 * 独立导出：本文件的其余路由会在任务 8（MCP 域整体重写）中被替换，**本函数必须保留**。
 */
export async function setProjectMcpScope(opts: {
  projectStore: ProjectStore;
  projectId: string;
  enabled: boolean;
  /** trust.json 路径（缺省 <WA_PI_DIR>/trust.json；测试注入 tmpdir 用） */
  trustFile?: string;
}): Promise<void> {
  // 默认工作区没有任何工作区语义，直接拒绝（与 git 域对 __system__ 同一策略）。
  // 必须挡在任何落盘之前：它的 cwd 是 <WA_PI_DIR>/workdir，一旦写 true，查表做祖先继承
  // 会连同该目录下每个会话的 <createdAt>/ 子目录、以及将来所有落在 workdir 下的工作目录
  // 一并受信（受信是持久化的安全决定，一次误触不该把共享数据目录整棵子树标成「可自动读
  // `.pi/mcp.json` 并起 MCP 服务器」）。
  if (opts.projectId === SYSTEM_PROJECT_ID) {
    throw new KernelError(
      "mcp.systemProject",
      undefined,
      "默认工作区不支持项目级 MCP 作用域开关",
    );
  }
  // 项目 id → cwd 一律走既有解析（不自行拼路径）：项目不存在 / cwd 缺失都会抛 KernelError
  const cwd = await resolveCwdForFsRequest(opts.projectStore, opts.projectId);
  // 关闭时写 false 而不是删键：删键会退回上层继承，可能意外继承父目录的受信决定
  await new McpTrustStore(opts.trustFile ?? trustFilePath()).set(cwd, opts.enabled);
  // 仅开启时迁移：关闭状态 pi 不读 <cwd>/.pi/mcp.json，迁移无意义且会凭空造出 .pi/ 目录
  if (opts.enabled) await migrateProjectMcpFile(cwd);
}

export const registerMcpRoutes: RouteRegistrar = (r, callApi, ctx) => {
  // ---- 项目级 MCP 作用域开关（规格 §5 / F11-F13）----
  // 不经 WS 事件表（callApi）：这是 HTTP 原生的新端点。任务 8 重写 MCP 域时
  // **必须原样保留**本段（含上方的 setProjectMcpScope）。
  r.add("POST", "/api/mcp/project-scope", async (req) => {
    const b = await readJsonBody(req);
    if (typeof b.projectId !== "string" || !b.projectId) {
      return paramErrorResponse("缺少 projectId", "projectId");
    }
    // 必须显式判布尔：false 是合法值，真值判断会把「关闭」当成未传
    if (typeof b.enabled !== "boolean") {
      return paramErrorResponse("enabled 必须是布尔值", "enabled");
    }
    try {
      await setProjectMcpScope({
        projectStore: ctx.projectStore,
        projectId: b.projectId,
        enabled: b.enabled,
      });
    } catch (e) {
      // project.notFound → 404，其余（含 project.cwdMissing）→ 400：与 git 域同一约定
      const failure = toKernelPayload(e);
      const status = failure?.code === "project.notFound" ? 404 : 400;
      return Response.json(
        {
          error: e instanceof Error ? e.message : String(e),
          ...(failure ? { failure } : {}),
        },
        { status },
      );
    }
    return Response.json({ ok: true, projectId: b.projectId, enabled: b.enabled });
  });

  r.add("GET", "/api/mcp", async (req) => {
    const projectId =
      new URL(req.url).searchParams.get("projectId") ?? undefined;
    return callApi({ type: "mcp:list", projectId });
  });

  r.add("POST", "/api/mcp", async (req) => {
    const b = await readJsonBody(req);
    return callApi({
      type: "mcp:save",
      projectId: b.projectId,
      config: b.config,
      originalName: b.originalName,
    });
  });

  r.add("DELETE", "/api/mcp/:serverName", async (req, p) => {
    const projectId =
      new URL(req.url).searchParams.get("projectId") ?? undefined;
    return callApi({ type: "mcp:delete", serverName: p.serverName, projectId });
  });

  r.add("POST", "/api/mcp/test", async (req) => {
    const b = await readJsonBody(req);
    // mcp:testResult 由 handler 显式 broadcast 到 SSE 总线（见 ws-server.ts），fire-and-forget。
    return callApi({
      type: "mcp:test",
      serverName: b.serverName,
      projectId: b.projectId,
    });
  });

  r.add("GET", "/api/mcp/:serverName/tools", async (req, p) => {
    const projectId =
      new URL(req.url).searchParams.get("projectId") ?? undefined;
    // mcp:tools 由 handler 显式广播到 SSE 总线，fire-and-forget。
    return callApi({
      type: "mcp:listTools",
      serverName: p.serverName,
      projectId,
    });
  });
};
