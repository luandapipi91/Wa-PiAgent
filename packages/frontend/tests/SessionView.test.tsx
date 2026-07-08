import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen } from "@testing-library/react";
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
