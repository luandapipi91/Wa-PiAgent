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
  /** 正在测试/授权的服务器名（null=无进行中操作） */
  testingServer: string | null;
  /** 各服务器最近一次错误信息（测试失败时填充） */
  errors: Record<string, string>;

  load(projectId?: string): void;
  setServers(data: McpListResult | McpChangedEvent): void;
  setTestResult(data: McpTestResult): void;
  setToolsResult(data: McpToolsResult): void;
  save(config: McpServerConfig, projectId?: string, originalName?: string): void;
  deleteServer(serverName: string, projectId?: string): void;
  testConnection(serverName: string, projectId?: string): void;
  listTools(serverName: string, projectId?: string): void;
  clearAuth(serverName: string, projectId?: string): void;
  setSelectedProjectId(id: string | null): void;
  setSearchQuery(q: string): void;
}

export const useMcpStore = create<McpState>((set) => ({
  servers: [],
  selectedProjectId: null,
  searchQuery: "",
  loading: false,
  serverStatuses: {},
  toolCounts: {},
  toolsCache: {},
  testingServer: null,
  errors: {},

  load: (projectId) => {
    set((s) => ({ loading: true, selectedProjectId: projectId ?? s.selectedProjectId }));
    send({ type: "mcp:list", projectId });
  },
  setServers: (data) => set({ servers: data.servers, loading: false }),
  setTestResult: (data) =>
    set((s) => {
      const status: McpServerStatus = data.status ?? (data.success ? "connected" : "error");
      return {
        testingServer: null,
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
    })),
  save: (config, projectId, originalName) =>
    send({ type: "mcp:save", projectId, config, originalName }),
  deleteServer: (serverName, projectId) =>
    send({ type: "mcp:delete", projectId, serverName }),
  testConnection: (serverName, projectId) => {
    set((s) => {
      const nextErrors = { ...s.errors };
      delete nextErrors[serverName];
      return { testingServer: serverName, errors: nextErrors };
    });
    send({ type: "mcp:test", projectId, serverName });
  },
  listTools: (serverName, projectId) =>
    send({ type: "mcp:listTools", projectId, serverName }),
  clearAuth: (serverName, projectId) => {
    set({ testingServer: serverName });
    send({ type: "mcp:clearAuth", projectId, serverName });
  },
  setSelectedProjectId: (id) => set({ selectedProjectId: id }),
  setSearchQuery: (q) => set({ searchQuery: q }),
}));
