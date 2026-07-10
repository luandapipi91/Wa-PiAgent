import { test, expect, mock, beforeEach } from "bun:test";
import type { ModelProvider } from "@hiagent/shared";

// 用一个可替换的 delegate，避免每个测试重新 mock 时 providers store 模块缓存导致 send 没更新
let sendDelegate = mock((..._args: any[]) => {});
mock.module("../src/ws-instance", () => ({
  send: (...args: any[]) => sendDelegate(...args),
  onMessage: () => () => {},
}));

const { useProvidersStore } = await import("../src/store/providers");

function sampleProvider(): ModelProvider {
  return {
    id: "p1", name: "Test", baseUrl: "https://api.test.com/v1", apiKey: "sk-test",
    api: "openai-completions",
    models: [{ id: "m1", contextWindow: 128000, maxTokens: 4096 }],
  };
}

beforeEach(() => {
  useProvidersStore.setState(useProvidersStore.getInitialState(), true);
  sendDelegate.mockClear();
});

test("load 发 provider:list", () => {
  useProvidersStore.getState().load();
  expect(sendDelegate).toHaveBeenCalledWith({ type: "provider:list" });
});

test("save 发 provider:save", () => {
  const p = sampleProvider();
  useProvidersStore.getState().save(p);
  expect(sendDelegate).toHaveBeenCalledWith({ type: "provider:save", provider: p });
});

test("remove 发 provider:delete", () => {
  useProvidersStore.getState().remove("p1");
  expect(sendDelegate).toHaveBeenCalledWith({ type: "provider:delete", id: "p1" });
});

test("setProviders 更新本地列表", () => {
  useProvidersStore.getState().setProviders([sampleProvider()]);
  expect(useProvidersStore.getState().providers).toHaveLength(1);
});
