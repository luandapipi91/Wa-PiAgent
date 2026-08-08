// packages/frontend/tests/ExtensionSection.test.tsx
import { test, expect, beforeEach, mock } from "bun:test";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ExtensionSection } from "../src/components/settings/ExtensionSection";
import { useExtensionsStore } from "../src/store/extensions";

// 安装/卸载等交互会触发 api.post（真实 fetch），happy-dom 在 about:blank 下对相对 URL
// 抛 NotSupportedError。mock 掉 api-client。
mock.module("../src/api-client", () => ({
  api: {
    get: () => Promise.resolve(null),
    post: () => Promise.resolve({}),
    put: () => Promise.resolve({}),
    del: () => Promise.resolve({}),
  },
}));

// 捕获 store 的真实 actions，用于 beforeEach 重置：部分测试会 override 单个 action 做 spy，
// 而 zustand 单例的 override 会跨测试残留，必须每轮恢复，否则污染后续测试。
const realActions = {
  installPackage: useExtensionsStore.getState().installPackage,
  uninstallPackage: useExtensionsStore.getState().uninstallPackage,
  upgradePackage: useExtensionsStore.getState().upgradePackage,
  togglePackage: useExtensionsStore.getState().togglePackage,
  retryInstall: useExtensionsStore.getState().retryInstall,
  removeInstall: useExtensionsStore.getState().removeInstall,
};

beforeEach(() => {
  useExtensionsStore.setState({
    ...realActions,
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
        name: "demo-toolkit",
        source: "npm",
        version: "0.3.1",
        description: "演示工具包",
        enabled: false,
      },
    ],
    installs: {},
    upgrading: {},
    uninstalling: {},
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
  expect(screen.getByTestId("ext-card-demo-toolkit")).toBeTruthy();
});

test("已启用插件显示升级按钮（有最新版本时）", () => {
  render(<ExtensionSection />);
  expect(screen.getByTestId("ext-upgrade-superpowers-zh")).toBeTruthy();
});

test("已禁用插件不显示升级按钮", () => {
  render(<ExtensionSection />);
  expect(screen.queryByTestId("ext-upgrade-demo-toolkit")).toBeNull();
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

// ===== 安装进度与状态（占位卡片） =====

test("点击安装：列表顶部出现「安装中」占位卡（不覆盖真实 installPackage）", async () => {
  // 使用真实 installPackage（不 override）：它会把占位条目写入 store，send 被 WS mock 吞掉
  render(<ExtensionSection />);
  fireEvent.change(screen.getByTestId("ext-install-input"), { target: { value: "new-pkg" } });
  fireEvent.click(screen.getByTestId("ext-install-btn"));

  const card = screen.getByTestId("ext-install-card-new-pkg");
  expect(card).toBeTruthy();
  expect(screen.getByTestId("ext-install-status-new-pkg").textContent).toContain("安装中");
});

test("安装中卡片显示流式进度消息", () => {
  useExtensionsStore.setState({
    installs: { "new-pkg": { name: "new-pkg", status: "installing", progress: "下载 new-pkg@1.2.3" } },
  });
  render(<ExtensionSection />);
  expect(screen.getByTestId("ext-install-progress-new-pkg").textContent).toContain("下载 new-pkg@1.2.3");
});

test("失败卡片显示「安装失败」+ 错误信息 + 重试 + 移除 按钮", () => {
  useExtensionsStore.setState({
    installs: { "bad-pkg": { name: "bad-pkg", status: "failed", error: "网络超时" } },
  });
  render(<ExtensionSection />);
  expect(screen.getByTestId("ext-install-status-bad-pkg").textContent).toContain("安装失败");
  expect(screen.getByTestId("ext-install-progress-bad-pkg").textContent).toContain("网络超时");
  expect(screen.getByTestId("ext-retry-bad-pkg")).toBeTruthy();
  expect(screen.getByTestId("ext-remove-bad-pkg")).toBeTruthy();
});

test("点击重试调用 retryInstall", () => {
  let retried = "";
  useExtensionsStore.setState({
    installs: { "bad-pkg": { name: "bad-pkg", status: "failed", error: "x" } },
    retryInstall: (n: string) => { retried = n; },
  });
  render(<ExtensionSection />);
  fireEvent.click(screen.getByTestId("ext-retry-bad-pkg"));
  expect(retried).toBe("bad-pkg");
});

test("点击移除调用 removeInstall", () => {
  let removed = "";
  useExtensionsStore.setState({
    installs: { "bad-pkg": { name: "bad-pkg", status: "failed", error: "x" } },
    removeInstall: (n: string) => { removed = n; },
  });
  render(<ExtensionSection />);
  fireEvent.click(screen.getByTestId("ext-remove-bad-pkg"));
  expect(removed).toBe("bad-pkg");
});

test("占位卡渲染在已安装列表之前（位于顶部）", () => {
  useExtensionsStore.setState({
    installs: { "new-pkg": { name: "new-pkg", status: "installing" } },
  });
  render(<ExtensionSection />);
  const installCard = screen.getByTestId("ext-install-card-new-pkg");
  const realCard = screen.getByTestId("ext-card-superpowers-zh");
  // installCard 应在 realCard 之前（realCard 跟在 installCard 后面）
  expect(installCard.compareDocumentPosition(realCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

// ===== 升级反馈（upgrading 状态）=====

test("升级中按钮显示「升级中」且禁用（防止重复点击）", () => {
  useExtensionsStore.setState({ upgrading: { "superpowers-zh": "下载 superpowers-zh@1.7.0" } });
  render(<ExtensionSection />);
  const btn = screen.getByTestId("ext-upgrade-superpowers-zh") as HTMLButtonElement;
  expect(btn.disabled).toBe(true);
  expect(btn.textContent).toContain("升级中");
});

test("升级中卡片显示流式进度消息", () => {
  useExtensionsStore.setState({ upgrading: { "superpowers-zh": "下载 superpowers-zh@1.7.0" } });
  render(<ExtensionSection />);
  expect(screen.getByTestId("ext-upgrade-progress-superpowers-zh").textContent).toContain("下载 superpowers-zh@1.7.0");
});

// ===== 卸载反馈（uninstalling 状态）=====

test("卸载中按钮显示「卸载中」且禁用（防止重复点击）", () => {
  useExtensionsStore.setState({ uninstalling: { "superpowers-zh": true } });
  render(<ExtensionSection />);
  const btn = screen.getByTestId("ext-uninstall-superpowers-zh") as HTMLButtonElement;
  expect(btn.disabled).toBe(true);
  expect(btn.textContent).toContain("卸载中");
});

test("点击确认卸载后按钮进入卸载中状态", () => {
  render(<ExtensionSection />);
  fireEvent.click(screen.getByTestId("ext-uninstall-superpowers-zh"));
  fireEvent.click(screen.getByTestId("confirm-ok"));
  const btn = screen.getByTestId("ext-uninstall-superpowers-zh") as HTMLButtonElement;
  expect(btn.disabled).toBe(true);
  expect(btn.textContent).toContain("卸载中");
});

test("卸载失败后按钮恢复可点（uninstalling 被清除）", () => {
  render(<ExtensionSection />);
  fireEvent.click(screen.getByTestId("ext-uninstall-superpowers-zh"));
  fireEvent.click(screen.getByTestId("confirm-ok"));
  // React 19 中非 act 的 store 更新不会同步 commit，需用 act 包裹（RTL 规范）
  act(() => {
    useExtensionsStore.getState().setError({
      type: "extension:error",
      name: "superpowers-zh",
      error: "卸载失败",
    });
  });
  const btn = screen.getByTestId("ext-uninstall-superpowers-zh") as HTMLButtonElement;
  expect(btn.disabled).toBe(false);
  expect(btn.textContent).toBe("卸载");
});
