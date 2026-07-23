import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { AgentConfig } from "@hiagent/shared";
import { App } from "../src/App";
import { useProjectsStore } from "../src/store/projects";
import { useAgentsStore } from "../src/store/agents";
import { useSessionStore } from "../src/store/session";

// 捕获 App 注册的 onMessage 处理器（模式同 App-error-prefix.test.tsx）
let handler: ((e: any) => void) | null = null;
const sendMock = mock();
mock.module("../src/ws-instance", () => ({
  getWs: () => ({ readyState: 1, addEventListener: () => {}, send: () => {} }),
  send: sendMock,
  onMessage: (h: any) => {
    handler = h;
    return () => {
      handler = null;
    };
  },
}));

const agent = (displayName: string): AgentConfig => ({
  displayName, avatar: "", avatarColor: "", description: "",
  model: "m", thinking: "medium", systemPromptMode: "replace",

  tools: [], skills: [], mcpServers: [], partners: { askTo: [] },
});

beforeEach(() => {
  handler = null;
  sendMock.mockClear();
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "P", cwd: "/p", createdAt: 0 }],
    sessions: [], currentProjectId: "p1", currentSessionId: null,
  });
  useAgentsStore.setState({ list: [agent("技术实现"), agent("项目管理")], configs: {} });
  useSessionStore.getState().clear();
});

test("agent_missing 错误 → 弹出重选弹窗，点击智能体发送 session:set-agent 后关窗", async () => {
  render(<App />);
  expect(handler).toBeTruthy();

  act(() => {
    handler!({ type: "error", message: "agent_missing", sessionId: "s1" });
  });

  await waitFor(() => expect(screen.getByTestId("agent-missing-modal")).toBeTruthy());
  expect(screen.getByText(/请重新选择智能体后重发消息/)).toBeTruthy();

  fireEvent.click(screen.getByTestId("agent-missing-item-项目管理"));
  // 恢复流程不弹缓存确认框，直接 set-agent
  expect(sendMock).toHaveBeenCalledWith({ type: "session:set-agent", sessionId: "s1", agentName: "项目管理" });
  await waitFor(() => expect(screen.queryByTestId("agent-missing-modal")).toBeNull());
});
