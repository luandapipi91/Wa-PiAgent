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

  load: (projectId) => {
    set((s) => ({ loading: true, selectedProjectId: projectId ?? s.selectedProjectId }));
    send({ type: "mcp:list", projectId });
  },
  setServers: (data) => set({ servers: data.servers, loading: false }),
  setTestResult: (data) =>
    set((s) => ({
      serverStatuses: {
        ...s.serverStatuses,
        [data.serverName]: data.success ? "connected" : "error",
      },
    })),
  setToolsResult: (data) =>
    set((s) => ({
      toolsCache: { ...s.toolsCache, [data.serverName]: data.tools },
    })),
  save: (config, projectId, originalName) =>
    send({ type: "mcp:save", projectId, config, originalName }),
  deleteServer: (serverName, projectId) =>
    send({ type: "mcp:delete", projectId, serverName }),
  testConnection: (serverName, projectId) =>
    send({ type: "mcp:test", projectId, serverName }),
  listTools: (serverName) =>
    send({ type: "mcp:listTools", serverName }),
  clearAuth: (serverName, projectId) =>
    send({ type: "mcp:clearAuth", projectId, serverName }),
  setSelectedProjectId: (id) => set({ selectedProjectId: id }),
  setSearchQuery: (q) => set({ searchQuery: q }),
}));
