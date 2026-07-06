import { test, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { SessionView } from "../src/components/SessionView";
import { useProjectsStore } from "../src/store/projects";
import { useIntercomStore } from "../src/store/intercom";
import { useAgentsStore } from "../src/store/agents";
import { useSessionStore } from "../src/store/session";

vi.mock("../src/ws-instance", () => ({ onMessage: () => () => {} }));

beforeEach(() => {
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "P", cwd: "/work/p1", createdAt: 0 }],
    sessions: [{ id: "s1", projectId: "p1", primaryAgent: "dev", title: "测试", createdAt: 0, lastActivity: 0 }],
    currentProjectId: "p1", currentSessionId: "s1",
  });
  useIntercomStore.setState({ asksBySession: {} });
  useAgentsStore.setState({ states: {}, configs: {} });
  useSessionStore.setState({ messagesBySession: {} });
});

test("渲染 header 标题 + 项目目录", () => {
  render(<SessionView sessionId="s1" onSwitchToCanvas={() => {}} />);
  expect(screen.getByText("测试")).toBeTruthy();
  expect(screen.getByText(/\/work\/p1/)).toBeTruthy();
});

test("无活跃 ask 不显示徽标", () => {
  render(<SessionView sessionId="s1" onSwitchToCanvas={() => {}} />);
  expect(screen.queryByTestId("intercom-badge")).toBeNull();
});

test("有活跃 ask 显示徽标", () => {
  useIntercomStore.setState({
    asksBySession: { s1: [{ messageId: "a1", sessionId: "s1", from: "product", to: "dev", text: "问", startedAt: Date.now(), resolved: false }] },
  });
  render(<SessionView sessionId="s1" onSwitchToCanvas={() => {}} />);
  expect(screen.getByTestId("intercom-badge")).toBeTruthy();
});
