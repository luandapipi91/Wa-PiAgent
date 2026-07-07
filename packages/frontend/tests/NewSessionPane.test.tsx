import { test, expect, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { NewSessionPane } from "../src/components/NewSessionPane";
import { useProjectsStore } from "../src/store/projects";

beforeEach(() => useProjectsStore.setState({
  projects: [{ id: "p1", name: "项目A", cwd: "/a", createdAt: 0 }],
  sessions: [], currentProjectId: "p1", currentSessionId: null,
}));

test("渲染项目+agent 下拉并排", () => {
  render(<NewSessionPane />);
  expect(screen.getByTestId("project-select")).toBeTruthy();
  expect(screen.getByTestId("agent-select")).toBeTruthy();
});

test("输入并发送后文本清空", () => {
  // 不 mock send（polyfill 兜底）；断言行为：输入后点发送，文本清空
  render(<NewSessionPane />);
  const input = screen.getByTestId("new-session-input") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "你好" } });
  expect(input.value).toBe("你好");
  fireEvent.click(screen.getByTestId("new-session-send"));
  expect(input.value).toBe("");
});
