import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { ExtensionSection } from "../src/components/settings/ExtensionSection";
import { useExtensionsStore } from "../src/store/extensions";

// 捕获 store 原始 action 方法，避免测试间 mock 泄漏
const originalActions = {
  togglePlugin: useExtensionsStore.getState().togglePlugin,
  load: useExtensionsStore.getState().load,
};

beforeEach(() => {
  useExtensionsStore.setState({
    plugins: [],
    togglePlugin: originalActions.togglePlugin,
    load: originalActions.load,
  });
});

test("无插件时显示空提示", () => {
  render(<ExtensionSection />);
  expect(screen.getByText("暂无插件")).toBeTruthy();
});

test("渲染插件 + checkbox 启用态 + 切换发 toggle", () => {
  const toggleMock = mock();
  useExtensionsStore.setState({
    plugins: [{
      id: "pi-lens", displayName: "Pi Lens", description: "代码反馈",
      enabled: true, version: "3.8.68",
    }],
    togglePlugin: toggleMock,
  });
  render(<ExtensionSection />);
  expect(screen.getByTestId("ext-name-pi-lens")).toBeTruthy();
  const cb = screen.getByTestId("ext-checkbox-pi-lens") as HTMLInputElement;
  expect(cb.checked).toBe(true);
  fireEvent.click(cb);
  expect(toggleMock).toHaveBeenCalledWith("pi-lens", false);
});

test("禁用插件 checkbox 未勾选 + 显示 [禁用]", () => {
  useExtensionsStore.setState({
    plugins: [{ id: "pi-lens", displayName: "Pi Lens", description: "x", enabled: false }],
  });
  render(<ExtensionSection />);
  const cb = screen.getByTestId("ext-checkbox-pi-lens") as HTMLInputElement;
  expect(cb.checked).toBe(false);
  expect(screen.getByText("[禁用]")).toBeTruthy();
});
