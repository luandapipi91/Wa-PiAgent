import { create } from "zustand";
import type { McpServerConfig, McpServerStatus, McpToolSummary } from "@hiagent/shared";
import type { McpListResult, McpChangedEvent, McpTestResult, McpToolsResult } from "@hiagent/shared";
import { send } from "../ws-instance";

interface McpState {
  servers: McpServerConfig[];
  selectedProjectId: string | null;
  searchQuery: string;
  loading: boolean;
  /** 各服务器运行时状态（客户端内存，不持久化） */
  serverStatuses: Record<string, McpServerStatus>;
  /** 连接测试成功时的工具数（供卡片展示「已连接 · N 工具」） */
  toolCounts: Record<string, number>;
  /** 工具列表缓存（按 serverName） */
  toolsCache: Record<string, McpToolSummary[]>;
  /** 正在加载工具列表的服务器集合（查看工具时的 loading 过渡） */
  loadingTools: Record<string, boolean>;
  /** 正在测试/授权的服务器集合（支持并行测试多个，如切换作用域后的批量自动测试） */
  testingServers: Record<string, boolean>;
  /** 各服务器最近一次错误信息（测试失败时填充） */
  errors: Record<string, string>;
  /** 已自动测试过连接的作用域（selectedProjectId），用于「切换项目后自动测一次」的去重：
   *  同一作用域的后续列表刷新（如 mcp:changed）不重复自动测试；undefined = 尚未测过任何作用域 */
  autoTestedProject: string | null | undefined;

  load(projectId?: string): void;
  setServers(data: McpListResult | McpChangedEvent): void;
  setTestResult(data: McpTestResult): void;
  setToolsResult(data: McpToolsResult): void;
  save(config: McpServerConfig, projectId?: string, originalName?: string): void;
  deleteServer(serverName: string, projectId?: string): void;
  testConnection(serverName: string, projectId?: string): void;
  /** 对当前 servers 列表逐个发起连接测试（用于切换项目作用域后的批量自动测试） */
  testAllServers(projectId?: string): void;
  listTools(serverName: string, projectId?: string): void;
  clearAuth(serverName: string, projectId?: string): void;
  setSelectedProjectId(id: string | null): void;
  setSearchQuery(q: string): void;
}

export const useMcpStore = create<McpState>((set, get) => ({
  servers: [],
  selectedProjectId: null,
  searchQuery: "",
  loading: false,
  serverStatuses: {},
  toolCounts: {},
  toolsCache: {},
  loadingTools: {},
  testingServers: {},
  errors: {},
  autoTestedProject: undefined,

  load: (projectId) => {
    set((s) => ({ loading: true, selectedProjectId: projectId ?? s.selectedProjectId }));
    send({ type: "mcp:list", projectId });
  },
  setServers: (data) => {
    const s = get();
    // 切换到新作用域（或首次加载）后，服务器列表到达即自动测一次连接。
    // 同一作用域的后续刷新（mcp:changed）selectedProjectId === autoTestedProject，不重复测。
    const shouldAutoTest = data.servers.length > 0 && s.selectedProjectId !== s.autoTestedProject;
    set({
      servers: data.servers,
      loading: false,
      autoTestedProject: shouldAutoTest ? s.selectedProjectId : s.autoTestedProject,
    });
    if (shouldAutoTest) get().testAllServers(s.selectedProjectId ?? undefined);
  },
  setTestResult: (data) =>
    set((s) => {
      const status: McpServerStatus = data.status ?? (data.success ? "connected" : "error");
      const nextTesting = { ...s.testingServers };
      delete nextTesting[data.serverName];
      return {
        testingServers: nextTesting,
        serverStatuses: { ...s.serverStatuses, [data.serverName]: status },
        errors: status === "error"
          ? { ...s.errors, [data.serverName]: data.error ?? "连接失败" }
          : s.errors,
        toolCounts: status === "connected" && data.toolCount != null
          ? { ...s.toolCounts, [data.serverName]: data.toolCount }
          : s.toolCounts,
      };
    }),
  setToolsResult: (data) =>
    set((s) => ({
      toolsCache: { ...s.toolsCache, [data.serverName]: data.tools },
      loadingTools: { ...s.loadingTools, [data.serverName]: false },
    })),
  save: (config, projectId, originalName) =>
    send({ type: "mcp:save", projectId, config, originalName }),
  deleteServer: (serverName, projectId) =>
    send({ type: "mcp:delete", projectId, serverName }),
  testConnection: (serverName, projectId) => {
    set((s) => {
      const nextErrors = { ...s.errors };
      delete nextErrors[serverName];
      return { testingServers: { ...s.testingServers, [serverName]: true }, errors: nextErrors };
    });
    send({ type: "mcp:test", projectId, serverName });
  },
  testAllServers: (projectId) => {
    const s = get();
    if (s.servers.length === 0) return;
    set((st) => {
      const nextTesting = { ...st.testingServers };
      for (const srv of st.servers) nextTesting[srv.name] = true;
      return { testingServers: nextTesting };
    });
    for (const srv of s.servers) {
      send({ type: "mcp:test", projectId, serverName: srv.name });
    }
  },
  listTools: (serverName, projectId) => {
    set((s) => ({ loadingTools: { ...s.loadingTools, [serverName]: true } }));
    send({ type: "mcp:listTools", projectId, serverName });
  },
  clearAuth: (serverName, projectId) => {
    set((s) => ({ testingServers: { ...s.testingServers, [serverName]: true } }));
    send({ type: "mcp:clearAuth", projectId, serverName });
  },
  setSelectedProjectId: (id) => set({ selectedProjectId: id }),
  setSearchQuery: (q) => set({ searchQuery: q }),
}));
