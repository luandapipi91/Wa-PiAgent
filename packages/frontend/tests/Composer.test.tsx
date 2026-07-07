import { test, expect, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { Composer } from "../src/components/Composer";
import { useProjectsStore } from "../src/store/projects";

// 不 mock send（vi.mock 在此环境拦截不稳定）；用 setup-websocket.ts 的 MockWebSocket 兜底，
// 真实 send 走 polyfill 不报错。断言 UI 行为：输入后点发送，文本清空 = 发送成功
beforeEach(() => useProjectsStore.setState({
  projects: [],
  sessions: [{ id: "s1", projectId: "p1", primaryAgent: "dev", title: "t", createdAt: 0, lastActivity: 0 }],
  currentProjectId: "p1",
  currentSessionId: "s1",
}));

test("输入并发送后文本清空", () => {
  render(<Composer sessionId="s1" agentName={"dev" as const} />);
  const input = screen.getByTestId("composer-input") as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: "继续" } });
  expect(input.value).toBe("继续");
  // 发送按钮 enabled
  expect((screen.getByTestId("composer-send") as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByTestId("composer-send"));
  // 发送后 input 清空（handleSend 调 setText("")）
  expect(input.value).toBe("");
});
