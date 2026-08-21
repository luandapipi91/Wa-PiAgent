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
  for (const id of [
    "browser-copy",
    "browser-refresh",
    "browser-code",
    "browser-share",
  ]) {
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

test("Windows 盘符绝对路径（反斜杠）匹配项目 cwd 可加载", () => {
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "P1", cwd: "C:\\proj\\dist", createdAt: 1 }],
  });
  render(<BrowserPanel />);
  const input = screen.getByTestId("browser-input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "C:\\proj\\dist\\index.html" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByTestId("html-preview-iframe")).toBeTruthy();
});

test("Windows 盘符绝对路径（正斜杠）匹配项目 cwd 可加载", () => {
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "P1", cwd: "C:/proj/dist", createdAt: 1 }],
  });
  render(<BrowserPanel />);
  const input = screen.getByTestId("browser-input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "C:/proj/dist/index.html" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByTestId("html-preview-iframe")).toBeTruthy();
});

test("Windows 盘符路径与 POSIX 项目 cwd 不匹配 → toast 拒绝", () => {
  render(<BrowserPanel />); // beforeEach 项目 cwd = /a
  const input = screen.getByTestId("browser-input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "C:\\proj\\dist\\index.html" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByTestId("browser-empty")).toBeTruthy(); // 未加载
  expect(useToastStore.getState().toasts[0]?.type).toBe("error");
});

test("项目 cwd 尾斜杠（/a/）不误拒项目内路径", () => {
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "P1", cwd: "/a/", createdAt: 1 }],
  });
  render(<BrowserPanel />);
  const input = screen.getByTestId("browser-input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "/a/index.html" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByTestId("html-preview-iframe")).toBeTruthy();
});

test("根目录项目（cwd=/）放行任意绝对路径", () => {
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "P1", cwd: "/", createdAt: 1 }],
  });
  render(<BrowserPanel />);
  const input = screen.getByTestId("browser-input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "/x/index.html" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByTestId("html-preview-iframe")).toBeTruthy();
});

test("Windows 盘符分隔符混用（cwd 反斜杠 + 输入正斜杠）可加载", () => {
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "P1", cwd: "C:\\proj\\dist", createdAt: 1 }],
  });
  render(<BrowserPanel />);
  const input = screen.getByTestId("browser-input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "C:/proj/dist/index.html" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByTestId("html-preview-iframe")).toBeTruthy();
});

test("Windows 盘符大小写不一致（cwd 大写 + 输入小写）可加载", () => {
  useProjectsStore.setState({
    projects: [{ id: "p1", name: "P1", cwd: "C:\\Proj\\Dist", createdAt: 1 }],
  });
  render(<BrowserPanel />);
  const input = screen.getByTestId("browser-input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "c:\\proj\\dist\\index.html" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByTestId("html-preview-iframe")).toBeTruthy();
});

test("UNC 路径（cwd 在共享目录）可加载", () => {
  useProjectsStore.setState({
    projects: [
      {
        id: "p1",
        name: "P1",
        cwd: "\\\\server\\share\\proj",
        createdAt: 1,
      },
    ],
  });
  render(<BrowserPanel />);
  const input = screen.getByTestId("browser-input") as HTMLInputElement;
  fireEvent.change(input, {
    target: { value: "\\\\server\\share\\proj\\dist\\index.html" },
  });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByTestId("html-preview-iframe")).toBeTruthy();
});

test("关闭按钮调用 closeBrowser", () => {
  render(<BrowserPanel />);
  fireEvent.click(screen.getByTestId("browser-close"));
  expect(useBrowserStore.getState().open).toBe(false);
});

test("输入域名（baidu.com）→ 外部 URL 渲染，自动补 https://", () => {
  render(<BrowserPanel />);
  const input = screen.getByTestId("browser-input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "baidu.com" } });
  fireEvent.keyDown(input, { key: "Enter" });
  const iframe = screen.getByTestId("html-preview-iframe") as HTMLIFrameElement;
  expect(iframe.getAttribute("src")).toBe("https://baidu.com");
  expect(iframe.getAttribute("sandbox")).toContain("allow-same-origin");
});

test("输入完整 http URL 原样渲染", () => {
  render(<BrowserPanel />);
  const input = screen.getByTestId("browser-input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "http://localhost:3000/x" } });
  fireEvent.keyDown(input, { key: "Enter" });
  const iframe = screen.getByTestId("html-preview-iframe") as HTMLIFrameElement;
  expect(iframe.getAttribute("src")).toBe("http://localhost:3000/x");
});

test(".html 结尾的外部 URL 不被误拒", () => {
  render(<BrowserPanel />);
  const input = screen.getByTestId("browser-input") as HTMLInputElement;
  fireEvent.change(input, {
    target: { value: "https://example.com/about.html" },
  });
  fireEvent.keyDown(input, { key: "Enter" });
  const iframe = screen.getByTestId("html-preview-iframe") as HTMLIFrameElement;
  expect(iframe.getAttribute("src")).toBe("https://example.com/about.html");
});

test("同源 URL 被拒绝（外部模式 allow-same-origin 下禁止加载宿主自身源）", () => {
  render(<BrowserPanel />);
  const input = screen.getByTestId("browser-input") as HTMLInputElement;
  const sameOrigin = window.location.origin + "/preview/x/index.html";
  fireEvent.change(input, { target: { value: sameOrigin } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByTestId("browser-empty")).toBeTruthy(); // 未加载
  expect(useToastStore.getState().toasts[0]?.type).toBe("error");
});

test("外部 URL 时代码/分享按钮禁用，复制可用", () => {
  render(<BrowserPanel />);
  const input = screen.getByTestId("browser-input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "baidu.com" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(
    (screen.getByTestId("browser-code") as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(
    (screen.getByTestId("browser-share") as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(
    (screen.getByTestId("browser-copy") as HTMLButtonElement).disabled,
  ).toBe(false);
});

test("相对 html 路径（index.html）→ toast 拒绝不加载", () => {
  render(<BrowserPanel />);
  const input = screen.getByTestId("browser-input") as HTMLInputElement;
  fireEvent.change(input, { target: { value: "index.html" } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(screen.getByTestId("browser-empty")).toBeTruthy();
  expect(useToastStore.getState().toasts[0]?.type).toBe("error");
});

test("模式切换按钮：渲染 split/full，点击切换 store.mode", () => {
  useBrowserStore.setState({ mode: "split" });
  render(<BrowserPanel />);
  const splitBtn = document.querySelector('[data-testid="browser-mode-split"]')!;
  const fullBtn = document.querySelector('[data-testid="browser-mode-full"]')!;
  expect(splitBtn).toBeTruthy();
  expect(fullBtn).toBeTruthy();
  // 当前模式 aria-pressed=true
  expect(splitBtn.getAttribute("aria-pressed")).toBe("true");
  expect(fullBtn.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(fullBtn);
  expect(useBrowserStore.getState().mode).toBe("full");
  fireEvent.click(splitBtn);
  expect(useBrowserStore.getState().mode).toBe("split");
});
