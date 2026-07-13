// packages/frontend/tests/ExtensionSection.test.tsx
import { test, expect, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { ExtensionSection } from "../src/components/settings/ExtensionSection";
import { useExtensionsStore } from "../src/store/extensions";

beforeEach(() => {
  useExtensionsStore.setState({
    packages: [
      {
        name: "superpowers-zh",
        source: "npm",
        version: "1.6.0",
        latestVersion: "1.7.0",
        description: "AI 编程超能力中文增强版",
        enabled: true,
      },
      {
        name: "pi-lens",
        source: "npm",
        version: "0.3.1",
        description: "LSP 诊断",
        enabled: false,
      },
    ],
    error: null,
  });
});

test("渲染安装输入框和按钮", () => {
  render(<ExtensionSection />);
  expect(screen.getByTestId("ext-install-input")).toBeTruthy();
  expect(screen.getByTestId("ext-install-btn")).toBeTruthy();
});

test("渲染已安装插件卡片列表", () => {
  render(<ExtensionSection />);
  expect(screen.getByTestId("ext-card-superpowers-zh")).toBeTruthy();
  expect(screen.getByTestId("ext-card-pi-lens")).toBeTruthy();
});

test("已启用插件显示升级按钮（有最新版本时）", () => {
  render(<ExtensionSection />);
  expect(screen.getByTestId("ext-upgrade-superpowers-zh")).toBeTruthy();
});

test("已禁用插件不显示升级按钮", () => {
  render(<ExtensionSection />);
  expect(screen.queryByTestId("ext-upgrade-pi-lens")).toBeNull();
});

test("点击安装按钮调用 installPackage", async () => {
  let installedName = "";
  useExtensionsStore.setState({ installPackage: (n) => { installedName = n; } });
  render(<ExtensionSection />);
  const input = screen.getByTestId("ext-install-input");
  fireEvent.change(input, { target: { value: "new-pkg" } });
  fireEvent.click(screen.getByTestId("ext-install-btn"));
  expect(installedName).toBe("new-pkg");
});

test("点击卸载按钮弹出确认弹窗", () => {
  render(<ExtensionSection />);
  fireEvent.click(screen.getByTestId("ext-uninstall-superpowers-zh"));
  expect(screen.getByTestId("confirm-dialog")).toBeTruthy();
});

test("安装按钮在输入为空时禁用", () => {
  render(<ExtensionSection />);
  expect((screen.getByTestId("ext-install-btn") as HTMLButtonElement).disabled).toBe(true);
});
