import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen } from "@testing-library/react";
import { App } from "../src/App";
import { useProjectsStore } from "../src/store/projects";

mock.module("../src/ws-instance", () => ({
  getWs: () => ({ readyState: 1, addEventListener: () => {}, send: () => {} }),
  send: () => {},
  onMessage: () => () => {},
}));

beforeEach(() => useProjectsStore.setState({
  projects: [], sessions: [], currentProjectId: null, currentSessionId: null,
}));

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
