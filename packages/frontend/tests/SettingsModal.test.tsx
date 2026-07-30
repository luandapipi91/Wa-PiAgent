import { test, expect, mock, beforeEach } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { SettingsModal } from "../src/components/SettingsModal";
import { useSettingsStore } from "../src/store/settings";
import { useProvidersStore } from "../src/store/providers";

// 点击添加供应商等交互会触发 api（如 /api/models/presets，真实 fetch），happy-dom 在
// about:blank 下对相对 URL 抛 NotSupportedError。mock 掉 api-client。presets 路径需
// 返回结构化对象（ProviderFormModal 取 res.presets），其他返回 null 避免覆盖 store。
mock.module("../src/api-client", () => ({
  api: {
    get: (path: string) => {
      if (path.includes("/presets")) return Promise.resolve({ presets: [] });
      return Promise.resolve(null);
    },
    post: () => Promise.resolve({}),
    put: () => Promise.resolve({}),
    del: () => Promise.resolve({}),
  },
}));

beforeEach(() => {
  useSettingsStore.setState(useSettingsStore.getInitialState(), true);
  useProvidersStore.setState(useProvidersStore.getInitialState(), true);
});

test("渲染设置标题 + 左侧模型管理菜单", () => {
  render(<SettingsModal onClose={() => {}} />);
  expect(screen.getByText("系统设置")).toBeTruthy();
  expect(screen.getByText("模型管理")).toBeTruthy();
});

test("渲染添加供应商按钮", () => {
  render(<SettingsModal onClose={() => {}} />);
  expect(screen.getByTestId("add-provider-btn")).toBeTruthy();
});

test("点击添加供应商打开 ProviderFormModal", () => {
  render(<SettingsModal onClose={() => {}} />);
  fireEvent.click(screen.getByTestId("add-provider-btn"));
  expect(screen.getByTestId("provider-form-modal")).toBeTruthy();
});

test("供应商列表渲染卡片", () => {
  useProvidersStore.setState({
    providers: [{
      id: "p1", name: "Test Provider", baseUrl: "https://api.test.com/v1",
      apiKey: "sk-test", api: "openai-completions",
      models: [{ id: "m1", contextWindow: 128000, maxTokens: 4096 }],
    }],
  });
  render(<SettingsModal onClose={() => {}} />);
  expect(screen.getByText("Test Provider")).toBeTruthy();
  expect(screen.getByText("openai-completions")).toBeTruthy();
});

test("删除供应商弹 ConfirmDialog", () => {
  useProvidersStore.setState({
    providers: [{
      id: "p1", name: "Test", baseUrl: "x", apiKey: "sk-test",
      api: "openai-completions", models: [{ id: "m", contextWindow: 1, maxTokens: 4096 }],
    }],
  });
  render(<SettingsModal onClose={() => {}} />);
  fireEvent.click(screen.getByTestId("provider-delete-p1"));
  expect(screen.getByTestId("confirm-dialog")).toBeTruthy();
});

test("确认删除调用 store.remove", () => {
  const removeMock = mock();
  useProvidersStore.setState({
    providers: [{
      id: "p1", name: "Test", baseUrl: "x", apiKey: "sk-test",
      api: "openai-completions", models: [{ id: "m", contextWindow: 1, maxTokens: 4096 }],
    }],
    remove: removeMock,
  });
  render(<SettingsModal onClose={() => {}} />);
  fireEvent.click(screen.getByTestId("provider-delete-p1"));
  fireEvent.click(screen.getByTestId("confirm-ok"));
  expect(removeMock).toHaveBeenCalledWith("p1");
});
