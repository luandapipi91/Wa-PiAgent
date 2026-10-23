import { test, expect, mock, beforeEach } from "bun:test";
import type { ModelProvider } from "@wa-pi/shared";

const calls: { method: string; path: string; body?: any }[] = [];
mock.module("../src/api-client", () => ({
  api: {
    get: (path: string) => { calls.push({ method: "get", path }); return Promise.resolve({}); },
    post: (path: string, body?: any) => { calls.push({ method: "post", path, body }); return Promise.resolve({}); },
    put: () => Promise.resolve({}),
    del: (path: string) => { calls.push({ method: "del", path }); return Promise.resolve({}); },
  },
  ApiError: class extends Error { status: number; constructor(m: string, s: number) { super(m); this.status = s; this.name = "ApiError"; } },
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
  calls.length = 0;
});

test("load 发 GET /api/providers", () => {
  useProvidersStore.getState().load();
  expect(calls).toEqual([{ method: "get", path: "/api/providers" }]);
});

test("save 发 POST /api/providers", () => {
  const p = sampleProvider();
  useProvidersStore.getState().save(p);
  expect(calls).toEqual([{ method: "post", path: "/api/providers", body: { provider: p } }]);
});

test("remove 发 DELETE /api/providers/:id", () => {
  useProvidersStore.getState().remove("p1");
  expect(calls).toEqual([{ method: "del", path: "/api/providers/p1" }]);
});

test("setProviders 更新本地列表", () => {
  useProvidersStore.getState().setProviders([sampleProvider()]);
  expect(useProvidersStore.getState().providers).toHaveLength(1);
});
