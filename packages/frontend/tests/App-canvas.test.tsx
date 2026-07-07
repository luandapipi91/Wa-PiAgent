import { test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { App } from "../src/App";
import { useProjectsStore } from "../src/store/projects";

// happy-dom 无原生 WebSocket，补一个空构造，避免 ws-instance 真实 new WebSocket 报错
// （ws-instance 的行为由下方 vi.mock 覆盖，这里只防 App useEffect 里 getWs() 兜底路径）
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  readyState = 1;
  addEventListener() {}
  send() {}
  close() {}
}
vi.stubGlobal("WebSocket", MockWebSocket);

vi.mock("../src/ws-instance", () => ({
  getWs: () => ({ readyState: 1, addEventListener: () => {}, send: () => {} }),
  send: () => {},
  onMessage: () => () => {},
}));

// mock reactflow：Canvas 内的 ReactFlow 透传节点（用 rf-mock 区分 Canvas 外层 testid）
vi.mock("reactflow", () => ({
  default: ({ nodes }: any) => (
    <div data-testid="rf-mock">{nodes.map((n: any) => <span key={n.id}>{n.id}</span>)}</div>
  ),
  Background: () => null,
}));

beforeEach(() => useProjectsStore.setState({
  projects: [{ id: "p1", name: "P", cwd: "/p", createdAt: 0 }],
  sessions: [{ id: "s1", projectId: "p1", primaryAgent: "dev", title: "t", createdAt: 0, lastActivity: 0 }],
  currentProjectId: "p1",
  currentSessionId: "s1",
}));

test("点编排画布切换到 canvas 视图", () => {
  render(<App />);
  fireEvent.click(screen.getByText("编排画布"));
  expect(screen.getByTestId("canvas")).toBeTruthy();
});

test("canvas 视图点返回会话回到 session", () => {
  render(<App />);
  fireEvent.click(screen.getByText("编排画布"));
  fireEvent.click(screen.getByText("← 返回会话"));
  // 回到 session 态：编排画布按钮重新可见
  expect(screen.getByText("编排画布")).toBeTruthy();
  expect(screen.queryByTestId("canvas")).toBeNull();
});
