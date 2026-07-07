import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen } from "@testing-library/react";
import { App } from "../src/App";
import { useProjectsStore } from "../src/store/projects";

// App 现在会调用 getWs()/onMessage()/load()，需 mock ws-instance，避免真实 WebSocket 连接。
mock.module("../src/ws-instance", () => ({
  getWs: () => ({ readyState: 1, addEventListener: () => {}, send: () => {} }),
  send: () => {},
  onMessage: () => () => {},
}));

beforeEach(() => useProjectsStore.setState({
  projects: [], sessions: [], currentProjectId: null, currentSessionId: null,
}));

test("App 渲染（empty 态冒烟）", () => {
  render(<App />);
  expect(screen.getByTestId("empty-state")).toBeTruthy();
});
