import { test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Composer } from "../src/components/Composer";
import { useProjectsStore } from "../src/store/projects";

vi.mock("../src/ws-instance", () => ({ send: vi.fn() }));

beforeEach(() => useProjectsStore.setState({
  projects: [],
  sessions: [{ id: "s1", projectId: "p1", primaryAgent: "dev", title: "t", createdAt: 0, lastActivity: 0 }],
  currentProjectId: "p1",
  currentSessionId: "s1",
}));

test("输入发送调 send 带 projectId/sessionId/agentName", async () => {
  const { send } = await import("../src/ws-instance");
  (send as any).mockClear();
  render(<Composer sessionId="s1" agentName={"dev" as const} />);
  fireEvent.change(screen.getByTestId("composer-input"), { target: { value: "继续" } });
  fireEvent.click(screen.getByTestId("composer-send"));
  const arg = (send as any).mock.calls[0][0];
  expect(arg).toEqual({ type: "agent:prompt", projectId: "p1", sessionId: "s1", agentName: "dev", text: "继续" });
});
