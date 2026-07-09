import { test, expect, mock } from "bun:test";
import type { ModelProvider } from "@hiagent/shared";

function sampleProvider(): ModelProvider {
  return {
    id: "p1", name: "Test", baseUrl: "https://api.test.com/v1", apiKey: "sk-test",
    api: "openai-completions",
    models: [{ id: "m1", contextWindow: 128000, maxTokens: 4096 }],
  };
}

test("load 发 provider:list", async () => {
  const sendMock = mock();
  mock.module("../src/ws-instance", () => ({
    send: sendMock,
    onMessage: () => () => {},
  }));
  const { useProvidersStore } = await import("../src/store/providers");
  useProvidersStore.setState({ providers: [], loading: false });
  useProvidersStore.getState().load();
  expect(sendMock).toHaveBeenCalledWith({ type: "provider:list" });
});

test("save 发 provider:save", async () => {
  const sendMock = mock();
  mock.module("../src/ws-instance", () => ({
    send: sendMock,
    onMessage: () => () => {},
  }));
  const { useProvidersStore } = await import("../src/store/providers");
  useProvidersStore.setState({ providers: [], loading: false });
  const p = sampleProvider();
  useProvidersStore.getState().save(p);
  expect(sendMock).toHaveBeenCalledWith({ type: "provider:save", provider: p });
});

test("remove 发 provider:delete", async () => {
  const sendMock = mock();
  mock.module("../src/ws-instance", () => ({
    send: sendMock,
    onMessage: () => () => {},
  }));
  const { useProvidersStore } = await import("../src/store/providers");
  useProvidersStore.setState({ providers: [], loading: false });
  useProvidersStore.getState().remove("p1");
  expect(sendMock).toHaveBeenCalledWith({ type: "provider:delete", id: "p1" });
});

test("setProviders 更新本地列表", async () => {
  const sendMock = mock();
  mock.module("../src/ws-instance", () => ({
    send: sendMock,
    onMessage: () => () => {},
  }));
  const { useProvidersStore } = await import("../src/store/providers");
  useProvidersStore.getState().setProviders([sampleProvider()]);
  expect(useProvidersStore.getState().providers).toHaveLength(1);
});
