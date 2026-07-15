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
  listTools(serverName: string): void;
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
  toolsCache: {},
  testingServer: null,
  errors: {},

  load: (projectId) => {
    set((s) => ({ loading: true, selectedProjectId: projectId ?? s.selectedProjectId }));
    send({ type: "mcp:list", projectId });
  },
  setServers: (data) => set({ servers: data.servers, loading: false }),
  setTestResult: (data) =>
    set((s) => ({
      testingServer: null,
      serverStatuses: {
        ...s.serverStatuses,
        [data.serverName]: data.success ? "connected" : "error",
      },
      errors: data.success
        ? s.errors
        : { ...s.errors, [data.serverName]: data.error ?? "连接失败" },
    })),
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
  listTools: (serverName) =>
    send({ type: "mcp:listTools", serverName }),
  clearAuth: (serverName, projectId) => {
    set({ testingServer: serverName });
    send({ type: "mcp:clearAuth", projectId, serverName });
  },
  setSelectedProjectId: (id) => set({ selectedProjectId: id }),
  setSearchQuery: (q) => set({ searchQuery: q }),
}));
