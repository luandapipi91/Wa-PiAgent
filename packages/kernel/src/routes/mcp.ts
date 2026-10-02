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
 * OAuth 登录（F20）同一模式：`POST /api/mcp/login` 只表示「已受理」，授权 URL 与结果
 * 经 SSE 的 mcp:login 回流（等待用户授权是分钟级的，卡在回包路径上会撞前端的请求超时）；
 * 登出相反：它只改本地凭据文件，同步等完再回包，失败直接当 400 文案给出。
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
import { canUseOAuth, mcpAuthKeysOf, readMcpAuthKeys } from "../mcp-admin";
import type { McpFile } from "../mcp-file";
import type { ProjectStore } from "../project-store";
import { McpTrustStore } from "../mcp-trust";
import { migrateProjectMcpFile } from "../mcp-migrate";
import {
  DEFAULT_LOGIN_TIMEOUT_SEC,
  MAX_LOGIN_TIMEOUT_SEC,
  McpLoginRunner,
  extractAuthorizationUrl,
  lastNonEmptyLine,
} from "../mcp-login";
import type { LoginRunResult } from "../mcp-login";
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
  // 开启时把旧 <cwd>/.mcp.json 合并进 <cwd>/.pi/mcp.json（幂等：目标已有同名条目一律跳过，
  // 无条目可迁就不落盘）。关闭时不迁移：pi 本来就不读项目配置，迁移只会凭空造出 .pi/ 目录。
  if (opts.enabled) await migrateProjectMcpFile(cwd);
}

/**
 * 回读项目级 MCP 作用域开关（对应端点 GET /api/mcp/project-scope / 缺口①）。
 *
 * 前端开关的初值必须来自事实，不能由 pi 的 note 反推：pi 只在「项目未受信 **且** 项目里
 * 已有 .pi/mcp.json」时才输出 note，而项目还没有配置文件时根本没有 note——靠 note 反推会把
 * 「未设置」显示成「已开」（此时 trust.json 里没条目，开关也无任何实际效果）。受信是安全决定，
 * UI 显示与事实不符不可接受。
 *
 * 返回值 = `McpTrustStore.get(cwd)`，支持祖先继承：显式设置过 → true/false；自己和祖先都没有
 * 条目 → `null`（前端以 `data-unset="true"` 标记未设置，界面上不显示文案）。
 *
 * 只读：不改 trust.json、不做 `__system__` 守卫（守卫挡的是落盘；读只是把那个目录
 * 的真实受信态原样报出来，且前端在默认工作区不显示开关）。
 */
export async function getProjectMcpScope(opts: {
  projectStore: ProjectStore;
  projectId: string;
  /** trust.json 路径（缺省 <WA_PI_DIR>/trust.json；测试注入 tmpdir 用） */
  trustFile?: string;
}): Promise<boolean | null> {
  // 项目 id → cwd 一律走既有解析（与写侧同一个函数，不自行拼路径）：项目不存在会抛 KernelError
  const cwd = await resolveCwdForFsRequest(opts.projectStore, opts.projectId);
  return await new McpTrustStore(opts.trustFile ?? trustFilePath()).get(cwd);
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
  /** SSE 广播出口（mcp:changed / mcp:testResult / mcp:tools / mcp:login） */
  broadcast: (e: WSServerEvent) => void;
  /**
   * 登录 / 登出子进程的参数（规格 F20）。
   *
   * runtime/cliPath 与 rpc-client 同一解析（不得另起一套）；agentDir 同时是
   * `pi mcp login` 的 `PI_CODING_AGENT_DIR` 与凭据文件 `<agentDir>/mcp-auth.json` 的位置
   * ——登录态（F19）就是读它，两处必须是同一个目录。
   */
  piSpawn: { runtime: string; cliPath: string; agentDir: string };
}

/** 列表条目：盘上配置 + pi 报的运行时状态（同名字段以 pi 为准） */
export interface McpServerEntry extends McpServerConfig {
  /** pi 报的作用域（global / project）；未连上或未被 pi 识别时缺省 */
  scope?: string;
  /** pi 已知取值：connected / failed / needs-auth / disabled（另有其它字符串） */
  state?: string;
  tools?: string[];
  error?: string;
  /**
   * 是否已登录（F19）：`<agentDir>/mcp-auth.json` 里有该 server（名 + URL）的凭据条目。
   * 只对 HTTP server 赋值（stdio 没有 OAuth，pi 会直接报 does not use OAuth）
   * ——它是登录/登出按钮的唯一依据：pi 的 `state` 分不清「需要登录」与「凭据在但连不上」。
   */
  signedIn?: boolean;
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
  /**
   * 发起 OAuth 登录（规格 F20）：授权 URL 与结果只走 SSE（mcp:login），不抛错。
   *
   * `cwd` 由调用方给定：路由必须在回包（200 已受理）**之前**就解析好 cwd
   * ——项目不存在这类错误一旦放到长任务里，就没有 HTTP 通道可以表达了。
   */
  login(input: {
    projectId?: string;
    serverName: string;
    timeoutSec: number;
    cwd: string;
  }): Promise<void>;
  /**
   * 登出：同步等 `pi mcp logout` 删掉凭据（只改本地文件、秒级），失败抛错由路由映射成 400。
   * 与 login 不同，它没有「等待用户」的阶段，走 HTTP 回包比走 SSE 直接。
   */
  logout(input: { projectId?: string; serverName: string }): Promise<void>;
}

/**
 * 登录 / 登出在最坏情况下（pi 没有任何输出）的兑底文案。
 *
 * pi 会把真正的原因（超时 cancelled / 不支持 OAuth / 连不上）打在末尾，
 * 只有它一个字都没打时才用这两句。
 */
const LOGIN_UNFINISHED_TEXT = "登录未完成（pi 没有输出原因）";
const LOGOUT_UNFINISHED_TEXT = "登出失败（pi 没有输出原因）";

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
    // 登录态是客户端凭据文件里的事实（F19），与作用域无关：一次读回来供下面逐台比对
    const signedInKeys = await readMcpAuthKeys(deps.piSpawn.agentDir);
    const res = await (await adminOf(projectId)).list(force);
    const byName = new Map(res.servers.map((r) => [r.name, r]));
    const servers: McpServerEntry[] = configs.map((c) => {
      const report = byName.get(c.name);
      // 展开而非挑字段：pi 的 report 形状可能随版本增字段（规格 F14），少一列不该丢信息
      const entry: McpServerEntry = report ? { ...c, ...report } : { ...c };
      // 登录态只对「可能走 OAuth」的 server 赋値：stdio 没有 OAuth；带静态 Authorization 头
      // （大小写不敏感）或 auth 配置的 HTTP server 走固定凭据，pi 的 login 会直接拒绝。
      // 给它们 false 只会让前端误以为「可以在 GUI 里登录」；判据与 pi 一致见 canUseOAuth。
      // 比对必须走与 pi 同一套键（F19）：1.0.0 起是 `mcp__<server>|<规范化 URL>`，
      // 迁移前是纯规范化 URL —— 两种都认，见 mcpAuthKeysOf。
      if (canUseOAuth(entry)) {
        const signedIn = mcpAuthKeysOf(signedInKeys, entry.name, entry.url!);
        if (signedIn !== null) entry.signedIn = signedIn;
      }
      return entry;
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
   * 广播的是**完整清单载荷**（含 `stale` / `note` / `errors`），与 `GET /api/mcp` 同形：
   * 前端靠这些元信息决定「状态未知」与「项目未受信」两处说明，丢了它们会让一次保存
   * 就把「配置为什么没生效」的解释抹掉（且把缓存里的连接态当成最新）。
   * 不为此多跑一次冷 `pi mcp list`：`listWithState` 本就会把这些字段一起取回来。
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
        const payload = await listWithState(projectId);
        deps.broadcast({ type: "mcp:changed", projectId, ...payload });
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

    async login({ projectId, serverName, timeoutSec, cwd }) {
      const emit = (
        phase: "running" | "authorizationUrl" | "ok" | "error",
        extra: { url?: string; line?: string; error?: string } = {},
      ) => {
        deps.broadcast({ type: "mcp:login", serverName, projectId, phase, ...extra });
      };
      // 先发一条 running：POST 只是「已受理」，前端靠它立刻进入「等待授权」而不用等 pi 开口
      emit("running");
      const runner = new McpLoginRunner(deps.adminForCwd(cwd), {
        ...deps.piSpawn,
        cwd,
      });
      let res: LoginRunResult;
      try {
        res = await runner.run({
          server: serverName,
          timeoutSec,
          // 逐行转发 pi 的 stdout（规格 F20）：带 URL 的那行单独成一条
          // authorizationUrl 事件（前端要让用户点/复制它），其余行只是进度文本
          onLine: (line) => {
            const url = extractAuthorizationUrl(line);
            if (url) emit("authorizationUrl", { url });
            else emit("running", { line });
          },
        });
      } catch (err) {
        // runner 本身不抛错（spawn 失败也走返回值）；这里挡的是意外异常，不能让它变成未处理拒绝
        emit("error", { error: err instanceof Error ? err.message : String(err) });
        return;
      }
      // 凭据落盘了（或已确认没落盘）→ 状态与工具清单都可能变：先**同步**失效所有缓存
      // （否则 UI 要等下次会话启动），再在后台广播带登录态的清单（与 save / remove 同序）
      deps.invalidateCaches();
      broadcastChanged(projectId);
      if (res.ok) emit("ok");
      else emit("error", { error: lastNonEmptyLine(res.output) || LOGIN_UNFINISHED_TEXT });
    },

    async logout({ projectId, serverName }) {
      // cwd 在回包路径上解析：项目不存在要直接 404，而不是拖到子进程里失败
      const cwd = await deps.cwdForProject(projectId);
      const runner = new McpLoginRunner(deps.adminForCwd(cwd), {
        ...deps.piSpawn,
        cwd,
      });
      const res = await runner.logout(serverName);
      if (!res.ok) {
        // 失败原因（服务器不存在 / pi 报错）原样交给前端：字典里没有对应 code，
        // 兑底文案就是用户唯一的信息
        throw new Error(lastNonEmptyLine(res.output) || LOGOUT_UNFINISHED_TEXT);
      }
      // 凭据没了 → 该 server 的 state 会从 connected 退回 needs-auth，工具清单也跟着变
      deps.invalidateCaches();
      broadcastChanged(projectId);
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

    // ---- 回读项目级开关：真值来自 trust.json（缺口①）----
    // 只读端点，不做 __system__ 守卫（写侧的 400 挡的是落盘；读只是把该目录的真实受信态报出来）。
    r.add("GET", "/api/mcp/project-scope", async (req) => {
      const projectId = new URL(req.url).searchParams.get("projectId");
      if (!projectId) return paramErrorResponse("缺少 projectId", "projectId");
      try {
        const enabled = await getProjectMcpScope({
          projectStore: ctx.projectStore,
          projectId,
        });
        return Response.json({ enabled });
      } catch (e) {
        return mcpErrorResponse(e);
      }
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

    // ---- OAuth 登录 / 登出（规格 F19/F20）----
    //
    // login 是**长任务**（要等用户在浏览器里走完授权，缺省上限 300s）：HTTP 只能在受理阶段
    // 表态，与 test / listTools 同一约定——立即 200 {ok:true}，授权 URL 与结果经 SSE
    // （mcp:login）回流。这也避开了 api-client 的 30s 请求超时。
    //
    // 正因为回包之后没有 HTTP 通道，**能在回包前判定的错误必须现在就判**：serverName 缺失 /
    // timeoutSec 非法 → 400，项目不存在（cwd 解析失败）→ 404。否则用户只能看到一个
    // 「已受理」然后永远等下去。
    r.add("POST", "/api/mcp/login", async (req) => {
      const b = await readJsonBody(req);
      if (typeof b.serverName !== "string" || !b.serverName) {
        return paramErrorResponse("缺少 serverName", "serverName");
      }
      const timeoutSec =
        b.timeoutSec === undefined ? DEFAULT_LOGIN_TIMEOUT_SEC : b.timeoutSec;
      // 必须显式判数字：0 / 负数 / NaN / 字符串都不是合法的等待时长（pi 的 --timeout 收秒数）
      if (
        typeof timeoutSec !== "number" ||
        !Number.isFinite(timeoutSec) ||
        timeoutSec <= 0
      ) {
        return paramErrorResponse("timeoutSec 必须是正数（秒）", "timeoutSec");
      }
      // 上限不能省：超过 MAX_LOGIN_TIMEOUT_SEC 的秒数会让 (timeoutSec + 宽限) * 1000 溢出 2^31−1，
      // setTimeout 把延时截断成 1ms → pi 刚 spawn 就被 SIGTERM，用户却只看到「pi 没有输出原因」
      // 这种误诊我们自己的错的文案；另一端还会把 pi 与它的回调监听挂上十几天。直接 400 说清楚，
      // 不静默改小用户要的时长（前端输入框也有 max，正常走不到这里）。
      if (timeoutSec > MAX_LOGIN_TIMEOUT_SEC) {
        return paramErrorResponse(
          `timeoutSec 不能超过 ${MAX_LOGIN_TIMEOUT_SEC} 秒`,
          "timeoutSec",
        );
      }
      let cwd: string;
      try {
        cwd = await deps.cwdForProject(b.projectId);
      } catch (e) {
        return mcpErrorResponse(e);
      }
      void handlers.login({
        serverName: b.serverName,
        projectId: b.projectId,
        timeoutSec,
        cwd,
      });
      return Response.json({ ok: true });
    });

    // logout 只改本地凭据文件（秒级），同步等它跑完再回包：失败原因（服务器不存在等）
    // 能直接当 400 文案给出去，比再走一条 SSE 错误事件简单。
    r.add("POST", "/api/mcp/logout", async (req) => {
      const b = await readJsonBody(req);
      if (typeof b.serverName !== "string" || !b.serverName) {
        return paramErrorResponse("缺少 serverName", "serverName");
      }
      try {
        await handlers.logout({ serverName: b.serverName, projectId: b.projectId });
      } catch (e) {
        return mcpErrorResponse(e);
      }
      return Response.json({ ok: true });
    });
  };
}
