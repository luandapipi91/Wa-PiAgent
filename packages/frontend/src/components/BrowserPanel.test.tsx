import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { useBrowserStore } from "../store/browser";
import { useToastStore } from "../store/toast";
import { useSessionStore } from "../store/session";
import { useProjectsStore } from "../store/projects";

mock.module("../../share-client", () => ({
  shareSettings: mock(async () => ({ hasToken: true, channel: "edgeone" })),
  shareUpload: mock(async () => ({ url: "https://x.example/s", expiresAt: 0 })),
  saveShareSettings: async () => {},
}));
mock.module("../../util/clipboard", () => ({
  copyToClipboard: mock(async () => {}),
}));

import { BrowserPanel } from "./BrowserPanel";

beforeEach(() => {
  useBrowserStore.setState({ open: true, path: null, sessionId: null });
  useToastStore.setState({ toasts: [] });
  useSessionStore.setState({ filePreview: null });
  // 预置一个项目 cwd，让「项目内路径」校验真实生效（/a 落在项目内，项目外路径被拒）
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "P1", cwd: "/a", createdAt: 1 }],
  });
});

test("空窗口显示引导", () => {
  render(<BrowserPanel />);
  expect(screen.getByTestId("browser-empty")).toBeTruthy();
  // 未加载路径：4 个动作按钮均 disabled
  for (const id of ["browser-copy", "browser-refresh", "browser-code", "browser-share"]) {
    expect((screen.getByTestId(id) as HTMLButtonElement).disabled).toBe(true);
  }
});

test("非法后缀输入提示", () => {
  render(<BrowserPanel />);
  const input = screen.getByTestId("browser-input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "/a/style.css" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByTestId("browser-empty")).toBeTruthy(); // 仍未加载
  expect(useToastStore.getState().toasts[0]?.type).toBe("error");
});

test("输入 html 路径回车后渲染 iframe", () => {
  render(<BrowserPanel />);
  const input = screen.getByTestId("browser-input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "/a/index.html" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByTestId("html-preview-iframe")).toBeTruthy();
});

test("项目外 html 路径拒绝加载", () => {
  render(<BrowserPanel />);
  const input = screen.getByTestId("browser-input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "/outside/index.html" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByTestId("browser-empty")).toBeTruthy(); // 未加载
  expect(useToastStore.getState().toasts[0]?.type).toBe("error");
});

test("关闭按钮调用 closeBrowser", () => {
  render(<BrowserPanel />);
  fireEvent.click(screen.getByTestId("browser-close"));
  expect(useBrowserStore.getState().open).toBe(false);
});
