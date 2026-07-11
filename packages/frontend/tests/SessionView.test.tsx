import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, waitFor, act } from "@testing-library/react";
import type { SessionMessage } from "@hiagent/shared";
import { SessionView } from "../src/components/SessionView";
import { useProjectsStore } from "../src/store/projects";
import { useAgentsStore } from "../src/store/agents";
import { useSessionStore } from "../src/store/session";

// ws-instance mock：onMessage 暴露触发器，让测试能模拟 kernel 响应。
// bun mock.module 不 hoist，但 factory 闭包可引用模块作用域的 mockHandlers。
const mockHandlers = { list: [] as Array<(e: any) => void> };
mock.module("../src/ws-instance", () => ({
  send: () => {},
  onMessage: (cb: any) => { mockHandlers.list.push(cb); return () => {}; },
}));

beforeEach(() => {
  mockHandlers.list = [];
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "P", cwd: "/work/p1", createdAt: 0 }],
    sessions: [{ id: "s1", projectId: "p1", primaryAgent: "dev", title: "测试", createdAt: 0, lastActivity: 0, piSessionFile: "" }],
    currentProjectId: "p1", currentSessionId: "s1",
  });
  useAgentsStore.setState({ states: {}, configs: {} });
  useSessionStore.setState({ messagesBySession: {} });
});

test("渲染 header 标题 + 项目目录", () => {
  render(<SessionView sessionId="s1" onSwitchToCanvas={() => {}} />);
  expect(screen.getByText("测试")).toBeTruthy();
  expect(screen.getByText(/\/work\/p1/)).toBeTruthy();
});

test("收到 session:messages 响应后填充历史消息", () => {
  // 直接测 store 的 setMessages（SessionView onMessage 收到响应后调它）
  // SessionMessage 形态：message 为 Pi 原生消息（带 role/timestamp），非旧 ChatMessage
  const history: SessionMessage[] = [
    { agentName: undefined, message: { role: "user", content: "历史问题", timestamp: 1 } },
    { agentName: "dev", message: { role: "assistant", content: [{ type: "text", text: "历史回复" }], model: "pi-test", stopReason: "end_turn", timestamp: 2 } },
  ];
  useSessionStore.getState().setMessages("s1", history);
  const msgs = useSessionStore.getState().messagesBySession["s1"];
  expect(msgs).toHaveLength(2);
  const first = msgs[0].message as any;
  expect(first.role).toBe("user");
  expect(first.content).toBe("历史问题");
});

test("首次进入会话历史未到时显示加载指示，响应到达后消失", async () => {
  render(<SessionView sessionId="s1" onSwitchToCanvas={() => {}} />);
  // 发出 session:messages 后、历史未到 → 对话区显示 loading
  await screen.findByTestId("history-loading-s1");

  // 模拟 kernel 响应：触发已注册的 onMessage 监听
  const history: SessionMessage[] = [
    { agentName: undefined, message: { role: "user", content: "历史问题", timestamp: 1 } },
  ];
  await act(async () => {
    mockHandlers.list.forEach(h => h({ type: "session:messages", sessionId: "s1", messages: history }));
  });

  // 响应到达 → 加载消失、历史消息出现
  await waitFor(() => {
    expect(screen.queryByTestId("history-loading-s1")).toBeNull();
    expect(screen.getByText("历史问题")).toBeTruthy();
  });
  // store 标志同步清掉
  expect(useSessionStore.getState().historyLoadingBySession["s1"]).toBe(false);
});

test("会话已有消息时进入不显示历史加载（避免刷新闪烁）", async () => {
  // 预置 s1 已有历史消息（模拟再次进入已访问过的会话）
  useSessionStore.getState().setMessages("s1", [
    { agentName: undefined, message: { role: "user", content: "已存在", timestamp: 1 } },
  ]);
  render(<SessionView sessionId="s1" onSwitchToCanvas={() => {}} />);
  // 有消息则即便 loading 标志为 true 也不显示加载指示
  await waitFor(() => {
    expect(screen.queryByTestId("history-loading-s1")).toBeNull();
    expect(screen.getByText("已存在")).toBeTruthy();
  });
});

test("切换会话后思考计时显示对应会话的已思考时长（不重置、不沿用旧会话）", async () => {
  const now = Date.now();
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "P", cwd: "/work/p1", createdAt: 0 }],
    sessions: [
      { id: "s1", projectId: "p1", primaryAgent: "dev", title: "t1", createdAt: 0, lastActivity: 0, piSessionFile: "" },
      { id: "s2", projectId: "p1", primaryAgent: "dev", title: "t2", createdAt: 0, lastActivity: 0, piSessionFile: "" },
    ],
    currentProjectId: "p1", currentSessionId: "s1",
  });
  useSessionStore.setState({
    statusBySession: { s1: "thinking", s2: "thinking" },
    thinkingSinceBySession: { s1: now - 5000, s2: now - 10000 },
  });

  const { rerender } = render(<SessionView sessionId="s1" onSwitchToCanvas={() => {}} />);
  // s1 已思考约 5s
  expect(await screen.findByText(/思考中 · (5|6)s/)).toBeTruthy();

  // 切换到 s2：应显示 s2 的约 10s，而不是沿用 s1 的 5s 或重置成 0
  rerender(<SessionView sessionId="s2" onSwitchToCanvas={() => {}} />);
  expect(await screen.findByText(/思考中 · (10|11)s/)).toBeTruthy();
});
