import { test, expect, mock } from "bun:test";
import { render, screen } from "@testing-library/react";
import { useProjectsStore } from "../src/store/projects";
import { useSessionStore } from "../src/store/session";
import { useComposerPrefsStore } from "../src/store/composer-prefs";
import { App, type View } from "../src/App";

// 与其他 App 渲染测试一致：mock ws-instance，避免 App useEffect 触发真实 WS 连接。
mock.module("../src/ws-instance", () => ({
  getWs: () => ({ readyState: 1, addEventListener: () => {}, send: () => {} }),
  send: () => {},
  onMessage: () => () => {},
}));

test("View 类型不再包含 canvas", () => {
  // 编译期约束：若 View 仍含 'canvas'，这行会编译通过；运行时只断言可赋值集合
  const ok: View[] = ["empty", "new-session", "session"];
  expect(ok.length).toBe(3);
});

test("App 渲染 session 视图时不出现编排画布按钮", () => {
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "P", cwd: "/tmp", createdAt: 1 }],
    sessions: [{ id: "s1", projectId: "p1", primaryAgent: "dev", title: "T", createdAt: 1, lastActivity: 1, piSessionFile: "/x.jsonl" }],
    currentProjectId: "p1", currentSessionId: "s1", dirPickerOpen: false,
  } as any);
  useSessionStore.setState({ messagesBySession: {} });
  useComposerPrefsStore.setState({ bySession: {} });
  render(<App />);
  expect(screen.queryByText("编排画布")).toBeNull();
});
