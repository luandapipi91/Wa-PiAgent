import { test, expect, beforeEach } from "bun:test";
import { render, screen } from "@testing-library/react";
import { App } from "../src/App";
import { useProjectsStore } from "../src/store/projects";

// 不再 mock ws-instance：全局 preload（happydom-setup → MockWebSocket）已让 getWs()/send() 安全 no-op，
// 避免 mock.module 跨文件缓存污染 fs-client.test.ts（多个文件 mock 同一 ws-instance 会互相覆盖）。

beforeEach(() => useProjectsStore.setState({
  projects: [], sessions: [], currentProjectId: null, currentSessionId: null,
}));

test("App 渲染（empty 态冒烟）", () => {
  render(<App />);
  expect(screen.getByTestId("empty-state")).toBeTruthy();
});
