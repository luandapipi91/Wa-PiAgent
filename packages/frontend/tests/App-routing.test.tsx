import "./mock-composer-db";
import { test, expect, mock, beforeEach } from "bun:test";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import type { AgentConfig } from "@wa-pi/shared";

// SessionView 挂载会拉 /api/sessions/:id/messages：返回空历史，其余路径返回 null
mock.module("../src/api-client", () => ({
  api: {
    get: (path: string) =>
      path.includes("/messages")
        ? Promise.resolve({ messages: [], isActive: false, thinkingSince: null })
        : Promise.resolve(null),
    post: () => Promise.resolve({}),
    put: () => Promise.resolve({}),
    del: () => Promise.resolve({}),
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

mock.module("../src/events", () => ({
  connectEvents: () => {},
  onMessage: () => () => {},
  onReconnect: () => () => {},
  onEventType: () => () => {},
  disconnectEvents: () => {},
  emitEventForTesting: () => {},
}));

import { App } from "../src/App";
import { useProjectsStore } from "../src/store/projects";
import { useAgentsStore } from "../src/store/agents";
import { useSessionStore } from "../src/store/session";

const agent = (displayName: string): AgentConfig => ({
  displayName,
  avatar: "",
  avatarColor: "",
  description: "",
  model: "m",
  thinking: "medium",
  tools: [],
  skills: [],
  mcpServers: [],
  partners: { askTo: [] },
});

const session = {
  id: "s1",
  projectId: "p1",
  primaryAgent: "dev",
  title: "会话一",
  createdAt: 0,
  lastActivity: 0,
  piSessionFile: "/tmp/s1.jsonl",
};

beforeEach(() => {
  useProjectsStore.setState({
    projects: [],
    sessions: [],
    currentProjectId: null,
    currentSessionId: null,
  });
  useAgentsStore.setState({ list: [], configs: { dev: agent("dev") } });
  useSessionStore.setState({
    messagesBySession: {},
    streamingBySession: {},
    statusBySession: {},
    optimisticEchoBySession: {},
    thinkingSinceBySession: {},
  });
});

test("无项目显示 empty 态", () => {
  render(<App />);
  expect(screen.getByTestId("empty-state")).toBeTruthy();
});

test("有项目无会话显示 new-session 态", () => {
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "P", cwd: "/p", createdAt: 0 }],
    sessions: [], currentProjectId: "p1", currentSessionId: null,
  });
  render(<App />);
  expect(screen.getByTestId("new-session-pane")).toBeTruthy();
});

// 复现审查发现 1：session 视图下切 automation 页签，
// 修复前 SessionView 与 AutomationMain 同屏堆叠；修复后互斥渲染。
test("session 视图切到 automation 页签：AutomationMain 独占，SessionView 不渲染，切回后恢复", async () => {
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "P", cwd: "/p", createdAt: 0 }],
    sessions: [session],
    currentProjectId: "p1",
    currentSessionId: "s1",
  });
  render(<App />);
  await act(async () => {});
  expect(screen.getByTestId("session-view")).toBeTruthy();

  // 切到 automation 页签：SessionView 卸载，AutomationMain 独占主区
  fireEvent.click(screen.getByTestId("sidebar-tab-automation"));
  await waitFor(() =>
    expect(screen.getByTestId("automation-main-header")).toBeTruthy(),
  );
  expect(screen.queryByTestId("session-view")).toBeNull();

  // 切回 tasks 页签：SessionView 恢复（view state 未被重置）
  fireEvent.click(screen.getByTestId("sidebar-tab-tasks"));
  await waitFor(() =>
    expect(screen.getByTestId("session-view")).toBeTruthy(),
  );
  expect(screen.queryByTestId("automation-main-header")).toBeNull();
});
