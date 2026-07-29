import { test, expect } from "bun:test";
import { rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ProviderStore } from "../src/provider-store";
import type { ModelProvider } from "@wa-pi/shared";

function tmpFile() {
  return join(import.meta.dir, ".tmp-providers-" + Math.random().toString(36).slice(2) + ".json");
}

function sampleProvider(overrides: Partial<ModelProvider> = {}): ModelProvider {
  return {
    id: "p1",
    name: "My DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-test",
    api: "openai-completions",
    models: [{ id: "deepseek-chat", contextWindow: 64000, maxTokens: 4096 }],
    ...overrides,
  };
}

test("load 文件不存在返回空数组", async () => {
  const f = tmpFile();
  const store = new ProviderStore(f);
  expect(await store.load()).toEqual([]);
  rmSync(f, { force: true });
});

test("save 新增后 load 能读回", async () => {
  const f = tmpFile();
  const store = new ProviderStore(f);
  await store.save(sampleProvider());
  const list = await store.load();
  expect(list).toHaveLength(1);
  expect(list[0].name).toBe("My DeepSeek");
  rmSync(f, { force: true });
});

test("save 同 id 更新（upsert）", async () => {
  const f = tmpFile();
  const store = new ProviderStore(f);
  await store.save(sampleProvider());
  await store.save(sampleProvider({ name: "Renamed", apiKey: "sk-new" }));
  const list = await store.load();
  expect(list).toHaveLength(1);
  expect(list[0].name).toBe("Renamed");
  expect(list[0].apiKey).toBe("sk-new");
  rmSync(f, { force: true });
});

test("delete 按 id 删除", async () => {
  const f = tmpFile();
  const store = new ProviderStore(f);
  await store.save(sampleProvider({ id: "p1" }));
  await store.save(sampleProvider({ id: "p2", name: "Other" }));
  await store.delete("p1");
  const list = await store.load();
  expect(list).toHaveLength(1);
  expect(list[0].id).toBe("p2");
  rmSync(f, { force: true });
});

test("delete 不存在的 id 不报错", async () => {
  const f = tmpFile();
  const store = new ProviderStore(f);
  await store.delete("nonexistent");
  expect(await store.load()).toEqual([]);
  rmSync(f, { force: true });
});

test("save 后文件结构为 { providers: [...] }", async () => {
  const f = tmpFile();
  const store = new ProviderStore(f);
  await store.save(sampleProvider());
  const raw = JSON.parse(readFileSync(f, "utf8"));
  expect(raw).toHaveProperty("providers");
  expect(raw.providers).toHaveLength(1);
  rmSync(f, { force: true });
});

test("supportsVision persists through save/load", async () => {
  const f = tmpFile();
  const store = new ProviderStore(f);
  await store.save(
    sampleProvider({
      models: [{ id: "gpt-4o", contextWindow: 128000, maxTokens: 4096, supportsVision: true }],
    })
  );
  const loaded = await store.load();
  expect(loaded).toHaveLength(1);
  expect(loaded[0].models[0].supportsVision).toBe(true);
  rmSync(f, { force: true });
});
