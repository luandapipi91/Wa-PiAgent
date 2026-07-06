import { test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NewSessionPane } from "../src/components/NewSessionPane";
import { useProjectsStore } from "../src/store/projects";

// mock ws-instance.send
vi.mock("../src/ws-instance", () => ({
  send: vi.fn(),
  getWs: () => ({}),
  onMessage: () => () => {},
}));

beforeEach(() => useProjectsStore.setState({
  projects: [{ id: "p1", name: "项目A", cwd: "/a", createdAt: 0 }],
  sessions: [], currentProjectId: "p1", currentSessionId: null,
}));

test("渲染项目+agent 下拉并排", () => {
  render(<NewSessionPane />);
  expect(screen.getByTestId("project-select")).toBeTruthy();
  expect(screen.getByTestId("agent-select")).toBeTruthy();
});

test("输入并发送调用 send", async () => {
  const { send } = await import("../src/ws-instance");
  (send as any).mockClear();
  render(<NewSessionPane />);
  const input = screen.getByTestId("new-session-input") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "你好" } });
  fireEvent.click(screen.getByTestId("new-session-send"));
  expect(send).toHaveBeenCalled();
  const arg = (send as any).mock.calls[0][0];
  expect(arg.type).toBe("agent:prompt");
  expect(arg.projectId).toBe("p1");
  expect(arg.text).toBe("你好");
});
