import { test, expect, beforeEach, mock } from "bun:test";
import { useProvidersStore } from "../src/store/providers";
import * as wsInstance from "../src/ws-instance";
import type { ModelProvider } from "@hiagent/shared";

// mock send，避免真连 WS
const sendMock = mock();
beforeEach(() => {
  sendMock.mockClear();
  mock.module("../src/ws-instance", () => ({ send: sendMock, onMessage: () => () => {} }));
  useProvidersStore.setState({ providers: [], loading: false });
});

function sampleProvider(): ModelProvider {
  return {
    id: "p1", name: "Test", baseUrl: "https://api.test.com/v1", apiKey: "sk-test",
    api: "openai-completions",
    models: [{ id: "m1", contextWindow: 128000, maxTokens: 4096 }],
  };
}

test("load 发 provider:list", () => {
  useProvidersStore.getState().load();
  expect(sendMock).toHaveBeenCalledWith({ type: "provider:list" });
});

test("save 发 provider:save", () => {
  const p = sampleProvider();
  useProvidersStore.getState().save(p);
  expect(sendMock).toHaveBeenCalledWith({ type: "provider:save", provider: p });
});

test("remove 发 provider:delete", () => {
  useProvidersStore.getState().remove("p1");
  expect(sendMock).toHaveBeenCalledWith({ type: "provider:delete", id: "p1" });
});

test("setProviders 更新本地列表", () => {
  const p = sampleProvider();
  useProvidersStore.getState().setProviders([p]);
  expect(useProvidersStore.getState().providers).toHaveLength(1);
});
