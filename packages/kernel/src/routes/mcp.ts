/**
 * MCP 域路由（阶段二·去 WS 化）
 *
 * 数据来源（规格 §7）—— 本域不自建 MCP 连接，也不持有 schema 逻辑：
 *   配置（唯一写入者）→ `mcp-file.ts` 的 `McpFile`：全局 `<WA_PI_DIR>/mcp.json`、
 *                       项目 `<project.cwd>/.pi/mcp.json`
 *   运行状态（唯一读取者）→ `mcp-admin.ts` 的 `McpAdmin`：`pi mcp list --json`
 * 旧实现（mcp-store.ts 的读写 + mcp-connector.ts 的自建连接）已无消费者，随本任务删除。
 *
 * projectId 一律从 query 取（可选，缺省为全局作用域）；serverName 在路径参数或 body 中。
 * save / delete 成功后先同步失效状态缓存，再经 SSE 广播 mcp:changed（广播在后台任务里，
 * 不占回包路径，见 handlers 内的 broadcastChanged）；
 * test / listTools 的结果只走 SSE（mcp:testResult / mcp:tools）——前端 fire-and-forget
 * 丢弃 HTTP 响应体，故成功时一律 200 {ok:true}，失败也在 SSE 事件里表达。
 */
import { join } from "node:path";
import {
  WA_PI_DIR,
  SYSTEM_PROJECT_ID,
  KernelError,
  toKernelPayload,
} from "@wa-pi/shared";
import type {
  McpFieldError,
  McpServerConfig,
  McpServerStatus,
  WSServerEvent,
} from "@wa-pi/shared";
import type { McpAdmin, McpServerReport } from "../mcp-admin";
import type { McpFile } from "../mcp-file";
import type { ProjectStore } from "../project-store";
import { McpTrustStore } from "../mcp-trust";
import { migrateProjectMcpFile } from "../mcp-migrate";
import { resolveCwdForFsRequest } from "../ws-server";
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
 * 独立导出：任务 8 重写了本文件其余路由的数据来源，**本函数必须保留**（规格 §5 的项目级开关）。
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

/**
 * MCP 域的外部依赖（ws-server 注入；缺一不可）。
 *
 * 为什么走工厂而不是往共享的 RouteContext 里塞字段：本域需要 5 个外部能力
 * （文件写入者、cwd 解析、状态读取者、缓存失效、SSE 广播），而与 git/share/scheduler
 * 域一致地由构造参数注入，RouteContext 才不必为每个域长出新字段。
 */
export interface McpRouteDeps {
  /** 配置读写（唯一写入者，mcp-file.ts） */
  mcpFile: McpFile;
  /** projectId（缺省 = 全局作用域）→ cwd；项目不存在 / cwd 缺失抛 KernelError */
  cwdForProject: (projectId?: string) => Promise<string>;
  /** 按 cwd 取状态读取者（与任务 7 的工具枚举共用同一批实例与缓存） */
  adminForCwd: (cwd: string) => Pick<McpAdmin, "list" | "invalidate">;
  /** 写操作后失效**所有**按 cwd 的状态缓存（见 AgentManager.invalidateMcpCaches） */
  invalidateCaches: () => void;
  /** SSE 广播出口（mcp:changed / mcp:testResult / mcp:tools） */
  broadcast: (e: WSServerEvent) => void;
}

/** 列表条目：盘上配置 + pi 报的运行时状态（同名字段以 pi 为准） */
export interface McpServerEntry extends McpServerConfig {
  /** pi 报的作用域（global / project）；未连上或未被 pi 识别时缺省 */
  scope?: string;
  /** pi 已知取值：connected / failed / needs-auth / disabled（另有其它字符串） */
  state?: string;
  tools?: string[];
  error?: string;
}

/** GET /api/mcp 的响应体：配置清单 + 状态读取层的元信息（规格 §8 的 stale 语义） */
export interface McpListPayload {
  servers: McpServerEntry[];
  errors: string[];
  commandFailed: boolean;
  hasProblems: boolean;
  stale: boolean;
  note?: string;
}

/** MCP 域业务处理器：REST 与 WS 两条入口共用同一份实现（避免两处逻辑漂移） */
export interface McpHandlers {
  list(projectId?: string): Promise<McpListPayload>;
  save(input: {
    projectId?: string;
    config: McpServerConfig;
    originalName?: string;
  }): Promise<{ ok: true } | { ok: false; errors: McpFieldError[] }>;
  remove(input: { projectId?: string; serverName: string }): Promise<void>;
  /** 结果经 SSE 广播（mcp:testResult），不抛错 */
  test(input: { projectId?: string; serverName: string }): Promise<void>;
  /** 结果经 SSE 广播（mcp:tools），不抛错 */
  listTools(input: { projectId?: string; serverName: string }): Promise<void>;
}

/** `pi mcp list` 的 state → 前端 McpServerStatus（规格 §7：测试/列工具取其 state） */
function toServerStatus(state: string | undefined): McpServerStatus {
  if (state === "connected") return "connected";
  // 用户主动关掉的 server pi 会报 state:"disabled"、退出码 0：那不是故障，不该在卡片上标红
  if (state === "disabled") return "disconnected";
  return "error";
}

/** KernelError → HTTP 响应：项目/服务器不存在 404，其余 400（与 git 域同一约定，旧 callApi 亦然） */
function mcpErrorResponse(e: unknown): Response {
  const payload = toKernelPayload(e);
  const status =
    payload?.code === "project.notFound" || payload?.code === "mcp.serverNotFound"
      ? 404
      : 400;
  return Response.json(
    {
      error: e instanceof Error ? e.message : String(e),
      ...(payload ? { failure: payload } : {}),
    },
    { status },
  );
}

/** MCP 域处理器工厂：deps 由 ws-server 注入，单测可只注入用到的部分 */
export function createMcpHandlers(deps: McpRouteDeps): McpHandlers {
  /** 取某作用域的状态读取者（`admin.list()` 走缓存；force 才重跑 `pi mcp list`） */
  async function adminOf(projectId?: string): Promise<Pick<McpAdmin, "list">> {
    return deps.adminForCwd(await deps.cwdForProject(projectId));
  }

  /**
   * 合并「盘上配置」与「pi 报的运行时状态」。
   *
   * 以**配置清单为骨架**：本作用域里配了但 pi 没报的 server（典型：项目未受信，pi 直接
   * 忽略 `.pi/mcp.json`）也要出现在列表里，否则用户看不到自己的配置、更无从编辑；
   * 这类条目没有 state，配合响应里的 `note`（pi 的「项目未受信任」提示）正好解释
   * 「我配的服务器为什么不生效」。pi 报的字段（scope/state/tools/error/enabled/exposure）
   * 覆盖同名配置字段——它们读的是同一个文件，pi 的解读更权威。
   */
  async function listWithState(
    projectId?: string,
    force = false,
  ): Promise<McpListPayload> {
    const configs = await deps.mcpFile.list(projectId);
    const res = await (await adminOf(projectId)).list(force);
    const byName = new Map(res.servers.map((r) => [r.name, r]));
    const servers: McpServerEntry[] = configs.map((c) => {
      const report = byName.get(c.name);
      // 展开而非挑字段：pi 的 report 形状可能随版本增字段（规格 F14），少一列不该丢信息
      return report ? { ...c, ...report } : { ...c };
    });
    // 逐字段拷贝而非 `...res`：list() 的返回值带 `raw`（pi 的完整 stdout），
    // 那是排查用的旁路数据，不该随 GUI 的列表响应外泄。
    return {
      servers,
      errors: res.errors,
      commandFailed: res.commandFailed,
      hasProblems: res.hasProblems,
      stale: res.stale,
      note: res.note,
    };
  }

  /** 取某 server 的运行时报告；pi 没报它时按「命令失败」/「服务器不存在」区分 */
  async function reportOf(
    serverName: string,
    projectId: string | undefined,
    force: boolean,
  ): Promise<McpServerReport> {
    const res = await (await adminOf(projectId)).list(force);
    const report = res.servers.find((s) => s.name === serverName);
    if (report) return report;
    // 命令没跑起来时 servers 恒为空：这时报「服务器不存在」会误导（配置其实在盘上）
    if (res.commandFailed) {
      throw new Error("无法读取 MCP 状态（pi mcp list 未返回结果），请稍后重试");
    }
    throw new KernelError("mcp.serverNotFound", { name: serverName });
  }

  /**
   * 写盘成功后广播一份带状态的清单。
   *
   * **不占回包路径**：`listWithState` 要读状态层，而冷缓存时那是一次真 spawn `pi mcp list`
   * （`McpAdmin` 的上限 `DEFAULT_LIST_TIMEOUT_MS = 30s`）。前端 `api-client` 的默认请求超时
   * 同为 30s、`store/mcp.ts` 又是 fire-and-forget ——只要盘上有一台卡死的 server，
   * 「保存 / 删除」就会在前端表现成失败（写盘其实已经成功）。故立即回包，广播放进后台任务。
   *
   * 后台任务的异常必须咽掉：调用方已拿到 200，此时冒出的 rejection 只会污染进程
   * （未处理拒绝告警，且可能误伤无关用例）；广播失败只影响 GUI 本次刷新，
   * 用户下次进面板仍会重新拉清单。
   */
  function broadcastChanged(projectId?: string): void {
    void (async () => {
      try {
        deps.broadcast({
          type: "mcp:changed",
          projectId,
          servers: (await listWithState(projectId)).servers,
        });
      } catch {
        // 同上：写盘已成功、回包已发出，广播失败不该升级为未处理拒绝
      }
    })();
  }

  return {
    list: (projectId) => listWithState(projectId),

    async save({ projectId, config, originalName }) {
      // 改名时原条目必须存在（旧 McpStore 的契约，前端 zh/en 字典有 mcp.originalServerNotFound）：
      // McpFile.save 对 originalName 只做「合并基底 + 删除旧键」，不存在时它会静默新建一个
      // **新名字**的条目——把「改名打错目标」变成静默改名，故存在性校验留在路由层。
      if (originalName && originalName !== config.name) {
        const existing = await deps.mcpFile.list(projectId);
        if (!existing.some((s) => s.name === originalName)) {
          throw new KernelError("mcp.originalServerNotFound", { name: originalName });
        }
      }
      const res = await deps.mcpFile.save(config, projectId, originalName);
      if (!res.ok) return res;
      // 盘上文件已变 → 先**同步**失效所有按 cwd 的状态缓存（否则 GUI 的改动要等下次会话启动才可见），
      // 再在后台广播带状态的清单：不 force 时 list() 因缓存被清空只重跑一次 `pi mcp list`
      deps.invalidateCaches();
      broadcastChanged(projectId);
      return { ok: true };
    },

    async remove({ projectId, serverName }) {
      await deps.mcpFile.delete(serverName, projectId);
      // 与 save 同序：失效在回包之前（同步），广播在后台
      deps.invalidateCaches();
      broadcastChanged(projectId);
    },

    async test({ projectId, serverName }) {
      const emit = (payload: {
        success: boolean;
        status: McpServerStatus;
        toolCount?: number;
        error?: string;
        code?: string;
        params?: Record<string, string | number>;
        detail?: string;
      }) => {
        deps.broadcast({ type: "mcp:testResult", serverName, ...payload });
      };
      try {
        // force：用户点「测试」要的是**此刻**的真实状态，不能拿缓存糊弄
        const report = await reportOf(serverName, projectId, true);
        const status = toServerStatus(report.state);
        emit({
          success: status === "connected",
          status,
          ...(status === "connected" ? { toolCount: report.tools?.length ?? 0 } : {}),
          ...(report.error && status === "error" ? { error: report.error } : {}),
        });
      } catch (err) {
        const payload = toKernelPayload(err);
        emit({
          success: false,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
          ...(payload
            ? { code: payload.code, params: payload.params, detail: payload.detail }
            : {}),
        });
      }
    },

    async listTools({ projectId, serverName }) {
      const emit = (tools: { name: string }[] | { error: string }) => {
        deps.broadcast({ type: "mcp:tools", serverName, ...(Array.isArray(tools) ? { tools } : tools) });
      };
      try {
        // force：与 test 同理由（点「查看工具」要此刻的真实清单）
        const report = await reportOf(serverName, projectId, true);
        // `pi mcp list --json` 的 tools 只有名字（无 description/parameters，规格 §7）：如实透传，
        // 不虚构字段——旧实现靠自建连接拿到的参数摘要随 mcp-connector.ts 一并消失。
        emit((report.tools ?? []).map((name) => ({ name })));
      } catch (err) {
        emit({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

export function createMcpRoutes(deps: McpRouteDeps): RouteRegistrar {
  const handlers = createMcpHandlers(deps);
  return (r, _callApi, ctx) => {
    // ---- 项目级 MCP 作用域开关（规格 §5 / F11-F13）----
    // 不经 WS 事件表（callApi）：这是 HTTP 原生的新端点。任务 8 重写 MCP 域数据来源时
    // **原样保留**本段（含上方的 setProjectMcpScope）。
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
        // project.notFound → 404，其余（含 project.cwdMissing / mcp.systemProject）→ 400：
        // 与 git 域同一约定
        return mcpErrorResponse(e);
      }
      return Response.json({ ok: true, projectId: b.projectId, enabled: b.enabled });
    });

    // ---- 服务器清单：盘上配置 + pi 报的运行时状态（规格 §7）----
    r.add("GET", "/api/mcp", async (req) => {
      const projectId =
        new URL(req.url).searchParams.get("projectId") ?? undefined;
      try {
        return Response.json(await handlers.list(projectId));
      } catch (e) {
        return mcpErrorResponse(e);
      }
    });

    // ---- 新增 / 编辑（自研读改写，规格 F15）----
    r.add("POST", "/api/mcp", async (req) => {
      const b = await readJsonBody(req);
      try {
        const res = await handlers.save({
          projectId: b.projectId,
          config: b.config ?? b,
          originalName: b.originalName,
        });
        if (!res.ok) {
          // 字段级错误交给表单逐项展示（规格 §8：非法则返回字段级错误）。
          // 不带 failure：字典里没有对应 code，而 error 已是首个字段级文案，
          // 前端遇到未知 code 会兑底成「未知错误」，不如原样展示这条。
          return Response.json(
            {
              error: res.errors[0]?.message ?? "MCP 服务器配置校验失败",
              errors: res.errors,
            },
            { status: 400 },
          );
        }
      } catch (e) {
        return mcpErrorResponse(e);
      }
      return Response.json({ ok: true });
    });

    r.add("DELETE", "/api/mcp/:serverName", async (req, p) => {
      const projectId =
        new URL(req.url).searchParams.get("projectId") ?? undefined;
      try {
        await handlers.remove({ serverName: p.serverName, projectId });
      } catch (e) {
        return mcpErrorResponse(e);
      }
      return Response.json({ ok: true });
    });

    // ---- 测试连接 / 列工具：结果只走 SSE（见 handlers），HTTP 仅表示「已受理」----
    r.add("POST", "/api/mcp/test", async (req) => {
      const b = await readJsonBody(req);
      await handlers.test({ serverName: b.serverName, projectId: b.projectId });
      return Response.json({ ok: true });
    });

    r.add("GET", "/api/mcp/:serverName/tools", async (req, p) => {
      const projectId =
        new URL(req.url).searchParams.get("projectId") ?? undefined;
      await handlers.listTools({ serverName: p.serverName, projectId });
      return Response.json({ ok: true });
    });
  };
}
