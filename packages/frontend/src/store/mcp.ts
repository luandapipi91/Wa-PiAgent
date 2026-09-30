import { create } from "zustand";
import i18n from "../i18n";
import type {
  McpFieldError,
  McpServerConfig,
  McpServerStatus,
  McpToolSummary,
} from "@wa-pi/shared";
import type {
  McpChangedEvent,
  McpListResult,
  McpTestResult,
  McpToolsResult,
} from "@wa-pi/shared";
import { api } from "../api-client";
import { formatApiError, formatKernelError } from "../util/kernel-error";
import { useToastStore } from "./toast";

/**
 * `GET /api/mcp` 的清单条目 = 盘上配置 + pi 报的运行时状态
 * （对齐 kernel `routes/mcp.ts` 的 `McpServerEntry`）。
 */
export interface McpServerEntry extends McpServerConfig {
  /** pi 报的作用域（global / project）；未被 pi 识别时缺省 */
  scope?: string;
  /**
   * pi 报的**原始** state 串：connected / failed / needs-auth / disabled / 其它
   * —— **不是** shared 里的三值联合 `McpServerStatus`（后者只用于本会话内的测试结果）。
   * 缺省 = pi 没报（未连上 / 未受信 / 状态读不到）→ UI 显示「状态未知」。
   */
  state?: string;
  /** pi 报的工具名清单（只有名字） */
  tools?: string[];
  error?: string;
}

/** `GET /api/mcp` 回包（对齐 kernel 的 `McpListPayload`） */
export interface McpListPayload {
  servers: McpServerEntry[];
  errors?: string[];
  commandFailed?: boolean;
  hasProblems?: boolean;
  /** 状态读取层无法刷新、用的是上一条缓存（规格 §8）→ UI 必须显示「状态未知」 */
  stale?: boolean;
  /** pi 的顶层提示（项目未受信任时配置被忽略的唯一信号） */
  note?: string;
}

/** 保存结果：字段级错误交给表单逐项绑定到输入框 */
export interface McpSaveResult {
  ok: boolean;
  /** 4xx 的字段级校验错误（kernel `errors[]`） */
  errors?: McpFieldError[];
  /** 非字段级的整体提示（如 mcp.originalServerNotFound） */
  message?: string;
}

interface McpState {
  servers: McpServerEntry[];
  /** 本次清单是否 stale（状态读不到、用的是上一条缓存）→ 全页显示「状态未知」 */
  stale: boolean;
  /** pi 的顶层提示（如「项目未受信任」），供 UI 解释配置为何不生效 */
  note?: string;
  selectedProjectId: string | null;
  searchQuery: string;
  loading: boolean;
  /** 各服务器**本次会话内测试**得出的状态（客户端内存，不持久化） */
  serverStatuses: Record<string, McpServerStatus>;
  /** 连接测试成功时的工具数（供卡片展示「已连接 · N 工具」） */
  toolCounts: Record<string, number>;
  /** 工具列表缓存（按 serverName） */
  toolsCache: Record<string, McpToolSummary[]>;
  /** 正在加载工具列表的服务器集合（查看工具时的 loading 过渡） */
  loadingTools: Record<string, boolean>;
  /** 正在测试的服务器集合 */
  testingServers: Record<string, boolean>;
  /** 各服务器最近一次错误信息（测试失败时填充） */
  errors: Record<string, string>;

  load(projectId?: string): void;
  /**
   * 装载清单。`scope` 为该清单所属作用域（`null` = 全局）：
   * 与当前选中作用域不符的清单直接丢弃——否则项目级改动会覆盖全局视图
   * （登记在案的既有缺陷，任务 9 修）。
   */
  setServers(
    data: McpListPayload | McpChangedEvent | McpListResult,
    scope?: string | null,
  ): void;
  setTestResult(data: McpTestResult): void;
  setToolsResult(data: McpToolsResult): void;
  save(
    config: McpServerConfig,
    projectId?: string,
    originalName?: string,
  ): Promise<McpSaveResult>;
  deleteServer(serverName: string, projectId?: string): Promise<void>;
  testConnection(serverName: string, projectId?: string): void;
  listTools(serverName: string, projectId?: string): void;
  /** 项目级 MCP 作用域开关（写 trust.json；`__system__` 会被 kernel 以 400 拒绝） */
  setProjectMcpScope(projectId: string, enabled: boolean): Promise<void>;
  setSelectedProjectId(id: string | null): void;
  setSearchQuery(q: string): void;
}

export const useMcpStore = create<McpState>((set, get) => ({
  servers: [],
  stale: false,
  note: undefined,
  selectedProjectId: null,
  searchQuery: "",
  loading: false,
  serverStatuses: {},
  toolCounts: {},
  toolsCache: {},
  loadingTools: {},
  testingServers: {},
  errors: {},

  load: (projectId) => {
    // 未显式传作用域时沿用当前选中（与既有语义一致）；请求 URL 与过滤用的 scope 必须是同一个值
    const scope =
      projectId !== undefined ? projectId : (get().selectedProjectId ?? null);
    set({ loading: true, selectedProjectId: scope });
    const url = scope ? `/api/mcp?projectId=${encodeURIComponent(scope)}` : "/api/mcp";
    api
      .get(url)
      .then((data: any) => {
        // 响应回来时用户可能已切到别的作用域：晚到的清单不得覆盖新视图
        if (!data || (get().selectedProjectId ?? null) !== scope) return;
        get().setServers(data, scope);
      })
      .catch(() => set({ loading: false }));
  },
  setServers: (data, scope) => {
    const s = get();
    // 作用域过滤：事件自带 projectId（REST 清单则由调用方给 scope），无 projectId 视为全局
    const owner =
      scope !== undefined
        ? scope
        : ((data as { projectId?: string }).projectId ?? null);
    if (owner !== (s.selectedProjectId ?? null)) return;
    const payload = data as McpListPayload;
    set({
      servers: payload.servers ?? [],
      // 状态读不到时（stale）不把可能过期的连接态当成最新
      stale: payload.stale === true,
      note: payload.note,
      loading: false,
    });
  },
  setTestResult: (data) =>
    set((s) => {
      const status: McpServerStatus =
        data.status ?? (data.success ? "connected" : "error");
      const nextTesting = { ...s.testingServers };
      delete nextTesting[data.serverName];
      return {
        testingServers: nextTesting,
        serverStatuses: { ...s.serverStatuses, [data.serverName]: status },
        errors:
          status === "error"
            ? {
                ...s.errors,
                [data.serverName]: data.code
                  ? // code 化错误：按字典渲染，老文案兜底
                    formatKernelError({
                      code: data.code,
                      params: data.params,
                      detail: data.detail,
                      message: data.error,
                    }).main
                  : (data.error ?? i18n.t("store.mcpConnectFailed")),
              }
            : s.errors,
        toolCounts:
          status === "connected" && data.toolCount != null
            ? { ...s.toolCounts, [data.serverName]: data.toolCount }
            : s.toolCounts,
      };
    }),
  setToolsResult: (data) =>
    set((s) => ({
      // listTools 失败分支（error）无 tools 字段，记为空数组
      toolsCache: { ...s.toolsCache, [data.serverName]: data.tools ?? [] },
      loadingTools: { ...s.loadingTools, [data.serverName]: false },
    })),
  save: async (config, projectId, originalName) => {
    try {
      await api.post("/api/mcp", { projectId, config, originalName });
      return { ok: true };
    } catch (e) {
      // 字段级错误（kernel 的 { error, errors[] }）交给表单逐项绑到输入框；
      // 用鸭子类型取 errors（不 instanceof ApiError：组件测试常 mock api-client 模块）
      const errors = (e as { errors?: McpFieldError[] } | null)?.errors;
      if (Array.isArray(errors) && errors.length > 0) {
        return { ok: false, errors };
      }
      return { ok: false, message: formatApiError(e) };
    }
  },
  deleteServer: async (serverName, projectId) => {
    try {
      await api.del(
        projectId
          ? `/api/mcp/${encodeURIComponent(serverName)}?projectId=${encodeURIComponent(projectId)}`
          : `/api/mcp/${encodeURIComponent(serverName)}`,
      );
    } catch (e) {
      // 删除失败不能静默（配置还在盘上，界面刷新后仍在）
      useToastStore.getState().add(formatApiError(e), "error");
    }
  },
  testConnection: (serverName, projectId) => {
    set((s) => {
      const nextErrors = { ...s.errors };
      delete nextErrors[serverName];
      return {
        testingServers: { ...s.testingServers, [serverName]: true },
        errors: nextErrors,
      };
    });
    void api.post("/api/mcp/test", { serverName, projectId });
  },
  listTools: (serverName, projectId) => {
    set((s) => ({ loadingTools: { ...s.loadingTools, [serverName]: true } }));
    void api.get(
      projectId
        ? `/api/mcp/${encodeURIComponent(serverName)}/tools?projectId=${encodeURIComponent(projectId)}`
        : `/api/mcp/${encodeURIComponent(serverName)}/tools`,
    );
  },
  setProjectMcpScope: async (projectId, enabled) => {
    try {
      await api.post("/api/mcp/project-scope", { projectId, enabled });
    } catch (e) {
      useToastStore.getState().add(formatApiError(e), "error");
      return;
    }
    // 受信状态变了 → 该作用域的清单要重读（pi 才会去读 .pi/mcp.json）
    get().load(get().selectedProjectId ?? undefined);
  },
  setSelectedProjectId: (id) => set({ selectedProjectId: id }),
  setSearchQuery: (q) => set({ searchQuery: q }),
}));
