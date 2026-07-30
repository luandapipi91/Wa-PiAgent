import "./mock-composer-db";
import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { AgentConfig } from "@wa-pi/shared";

const calls: { method: string; path: string; body?: any }[] = [];

mock.module("../src/api-client", () => ({
  api: {
    // get 返回 null（falsy）：App mount 时各 store.loadAll/load 的 if(data) 分支不触发，
    // 避免异步覆盖测试在 beforeEach 预设的 store 状态（agents/projects 等）。
    get: (path: string) => { calls.push({ method: "get", path }); return Promise.resolve(null); },
    post: (path: string, body?: any) => { calls.push({ method: "post", path, body }); return Promise.resolve({}); },
    put: (path: string, body?: any) => { calls.push({ method: "put", path, body }); return Promise.resolve({}); },
    del: (path: string, body?: any) => { calls.push({ method: "del", path, body }); return Promise.resolve({}); },
  },
  ApiError: class extends Error { status: number; constructor(m: string, s: number) { super(m); this.status = s; this.name = "ApiError"; } },
}));

// 隔离 SSE 事件总线，避免多文件共享 events.ts 模块导致 handler 注册/清理交叉污染
const eventHandlers = new Set<(e: any) => void>();
mock.module("../src/events", () => ({
  onMessage: (cb: any) => { eventHandlers.add(cb); return () => eventHandlers.delete(cb); },
  onEventType: () => () => {},
  connectEvents: () => {},
  disconnectEvents: () => { eventHandlers.clear(); },
  onReconnect: () => () => {},
  emitEventForTesting: (e: any) => { eventHandlers.forEach(h => h(e)); },
}));

import { App } from "../src/App";
import { useProjectsStore } from "../src/store/projects";
import { useAgentsStore } from "../src/store/agents";

const agent = (displayName: string): AgentConfig => ({
  displayName, avatar: "", avatarColor: "", description: "",
  model: "m", thinking: "medium", systemPromptMode: "replace",
  tools: [], skills: [], mcpServers: [], partners: { askTo: [] },
});

const project = { id: "p1", name: "P", cwd: "/p", createdAt: 0 };

const emitEvent = (e: any) => { eventHandlers.forEach(h => h(e)); };

beforeEach(() => {
  calls.length = 0;
  eventHandlers.clear();
  // 有项目无会话 → 默认落在 new-session 视图
  useProjectsStore.setState({
    projects: [project], sessions: [], currentProjectId: "p1", currentSessionId: null,
  });
  useAgentsStore.setState({ list: [], configs: {} });
});

test("挂载时请求 agent:list；收到 agent:list 事件写入 agents store", async () => {
  render(<App />);
  await act(async () => {});
  expect(calls.some(c => c.method === "get" && c.path === "/api/agents")).toBe(true);
  act(() => { emitEvent({ type: "agent:list", agents: [agent("技术实现")] }); });
  expect(useAgentsStore.getState().list.map(a => a.displayName)).toEqual(["技术实现"]);
});

test("侧栏点智能体 → 新建会话视图且下拉预选该智能体", async () => {
  useAgentsStore.setState({ list: [agent("技术实现"), agent("代码审查")] });
  render(<App />);
  await act(async () => {});
  // 初始默认第一项
  expect(screen.getByTestId("agent-select").textContent).toContain("技术实现");
  fireEvent.click(screen.getByTestId("agent-代码审查"));
  await waitFor(() => {
    expect(screen.getByTestId("agent-select").textContent).toContain("代码审查");
  });
});

test("侧栏「更多智能体」→ 打开宫格；点卡片 → 关宫格并预选", async () => {
  useAgentsStore.setState({ list: [agent("a1"), agent("a2"), agent("a3"), agent("代码审查")] });
  render(<App />);
  await act(async () => {});
  fireEvent.click(screen.getByTestId("agent-more"));
  expect(screen.getByTestId("agent-gallery")).toBeTruthy();
  fireEvent.click(screen.getByTestId("gallery-card-代码审查"));
  await waitFor(() => {
    expect(screen.queryByTestId("agent-gallery")).toBeNull();
  });
  expect(screen.getByTestId("agent-select").textContent).toContain("代码审查");
});

test("侧栏右键「编辑智能体」→ 打开 AgentConfig 弹窗", async () => {
  useAgentsStore.setState({ list: [agent("技术实现")] });
  render(<App />);
  await act(async () => {});
  fireEvent.contextMenu(screen.getByTestId("agent-技术实现"));
  fireEvent.click(screen.getByTestId("agent-ctx-edit"));
  await waitFor(() => expect(screen.getByTestId("agent-config")).toBeTruthy());
});

test("宫格新建成功 → 关宫格并打开新智能体配置弹窗（乐观打开契约）", async () => {
  useAgentsStore.setState({ list: [agent("a1"), agent("a2"), agent("a3"), agent("a4")] });
  render(<App />);
  await act(async () => {});
  fireEvent.click(screen.getByTestId("agent-more"));
  fireEvent.click(screen.getByTestId("gallery-create"));
  fireEvent.change(screen.getByTestId("gallery-create-input"), { target: { value: "新助手" } });
  fireEvent.click(screen.getByTestId("gallery-create-ok"));
  await waitFor(() => {
    expect(screen.queryByTestId("agent-gallery")).toBeNull();
    expect(screen.getByTestId("agent-config")).toBeTruthy();
  });
  // 配置弹窗头展示新智能体名（draft 未回时回退 agentName；未知名的回退 label 也是它，故多处匹配）
  expect(screen.getAllByText("新助手").length).toBeGreaterThanOrEqual(1);
});

test("pendingAgent 首次消费后清除：离开再进新建页不再预选旧值", async () => {
  useAgentsStore.setState({ list: [agent("技术实现"), agent("代码审查")] });
  // 无项目 → empty 视图（NewSessionPane 未挂载）
  useProjectsStore.setState({ projects: [], currentProjectId: null });
  render(<App />);
  await act(async () => {});
  // empty 视图点侧栏智能体 → 切新建页，pane 首次挂载并消费 pendingAgent
  fireEvent.click(screen.getByTestId("agent-代码审查"));
  await waitFor(() => {
    expect(screen.getByTestId("agent-select").textContent).toContain("代码审查");
  });
  // 给项目再清空（projects.length 变化驱动派生视图）：empty 视图，pane 卸载
  act(() => { useProjectsStore.setState({ projects: [project], currentProjectId: "p1" }); });
  act(() => { useProjectsStore.setState({ projects: [], currentProjectId: null }); });
  await waitFor(() => expect(screen.queryByTestId("agent-select")).toBeNull());
  // 回到新建页（恢复项目，pane 重新挂载）：pendingAgent 已消费清除，应回落列表第一项
  act(() => { useProjectsStore.setState({ projects: [project], currentProjectId: "p1" }); });
  await waitFor(() => expect(screen.getByTestId("agent-select")).toBeTruthy());
  expect(screen.getByTestId("agent-select").textContent).toContain("技术实现");
});
