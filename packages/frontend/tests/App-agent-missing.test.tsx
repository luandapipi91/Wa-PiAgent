import "./mock-composer-db";
import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { AgentConfig } from "@hiagent/shared";
import { App } from "../src/App";
import { useProjectsStore } from "../src/store/projects";
import { useAgentsStore } from "../src/store/agents";
import { useSessionStore } from "../src/store/session";
import { emitEventForTesting, disconnectEvents } from "../src/events";
import { composerDbDefaults, composerDbSessions } from "./mock-composer-db";

const calls: { method: string; path: string; body?: any }[] = [];

mock.module("../src/api-client", () => ({
  api: {
    get: (path: string) => {
      calls.push({ method: "get", path });
      return Promise.resolve({});
    },
    post: (path: string, body?: any) => {
      calls.push({ method: "post", path, body });
      return Promise.resolve({});
    },
    put: (path: string, body?: any) => {
      calls.push({ method: "put", path, body });
      return Promise.resolve({});
    },
    del: (path: string) => {
      calls.push({ method: "del", path });
      return Promise.resolve({});
    },
  },
  ApiError: class extends Error {
    status: number;
    constructor(m: string, s: number) {
      super(m);
      this.status = s;
      this.name = "ApiError";
    }
  },
}));

const agent = (displayName: string): AgentConfig => ({
  displayName,
  avatar: "",
  avatarColor: "",
  description: "",
  model: "m",
  thinking: "medium",
  systemPromptMode: "replace",
  tools: [],
  skills: [],
  mcpServers: [],
  partners: { askTo: [] },
});

beforeEach(() => {
  disconnectEvents();
  calls.length = 0;
  composerDbDefaults.model = null;
  composerDbDefaults.thinking = "disabled";
  for (const k of Object.keys(composerDbSessions)) delete composerDbSessions[k];
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "P", cwd: "/p", createdAt: 0 }],
    sessions: [],
    currentProjectId: "p1",
    currentSessionId: null,
  });
  useAgentsStore.setState({ list: [agent("技术实现"), agent("项目管理")], configs: {} });
  useSessionStore.getState().clear();
});

test("agent_missing 错误 → 弹出重选弹窗，点击智能体发送 set-agent 后关窗", async () => {
  render(<App />);
  // 等待 App useEffect 中的异步初始化（loadDefaults / onMessage 订阅等）稳定
  await act(async () => {});

  act(() => {
    emitEventForTesting({ type: "error", message: "agent_missing", sessionId: "s1" });
  });

  await waitFor(() => expect(screen.getByTestId("agent-missing-modal")).toBeTruthy());
  expect(screen.getByText(/请重新选择智能体后重发消息/)).toBeTruthy();

  fireEvent.click(screen.getByTestId("agent-missing-item-项目管理"));

  await waitFor(() => expect(screen.queryByTestId("agent-missing-modal")).toBeNull());

  const setAgentCall = calls.find((c) => c.method === "post" && c.path.includes("/set-agent"));
  expect(setAgentCall).toEqual({
    method: "post",
    path: "/api/sessions/s1/set-agent",
    body: { agentName: "项目管理" },
  });
});
