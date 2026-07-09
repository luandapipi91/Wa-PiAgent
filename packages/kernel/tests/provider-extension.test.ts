import { test, expect, afterAll } from "bun:test";
import { rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  slugifyProviders,
  generateProviderExtension,
  ensureProviderExtensionRegistered,
} from "../src/provider-extension";
import { GENERATED_DIR } from "@hiagent/shared";
import type { ModelProvider } from "@hiagent/shared";

function sampleProvider(overrides: Partial<ModelProvider> = {}): ModelProvider {
  return {
    id: "p1",
    name: "My DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    apiKey: "sk-xxx",
    api: "openai-completions",
    models: [
      { id: "deepseek-chat", contextWindow: 64000, maxTokens: 4096 },
      { id: "deepseek-reasoner", contextWindow: 64000, maxTokens: 4096 },
    ],
    ...overrides,
  };
}

test("slugifyProviders 分配唯一 slug", () => {
  const result = slugifyProviders([
    sampleProvider({ id: "p1", name: "My DeepSeek" }),
    sampleProvider({ id: "p2", name: "OpenAI" }),
  ]);
  expect(result[0].slug).toBe("my-deepseek");
  expect(result[1].slug).toBe("openai");
});

test("slugifyProviders 同名冲突加后缀", () => {
  const result = slugifyProviders([
    sampleProvider({ id: "p1", name: "My DeepSeek" }),
    sampleProvider({ id: "p2", name: "My DeepSeek" }),  // 同名
  ]);
  expect(result[0].slug).toBe("my-deepseek");
  expect(result[1].slug).toBe("my-deepseek-2");
});

test("generateProviderExtension 包含 registerProvider 调用", () => {
  const providers = [sampleProvider()];
  const code = generateProviderExtension(providers);
  expect(code).toContain('pi.registerProvider("my-deepseek"');
  expect(code).toContain('name: "My DeepSeek"');
  expect(code).toContain('baseUrl: "https://api.deepseek.com/v1"');
  expect(code).toContain('apiKey: "sk-xxx"');
  expect(code).toContain('api: "openai-completions"');
});

test("generateProviderExtension 包含所有模型", () => {
  const code = generateProviderExtension([sampleProvider()]);
  expect(code).toContain('id: "deepseek-chat"');
  expect(code).toContain('id: "deepseek-reasoner"');
  expect(code).toContain("contextWindow: 64000");
  expect(code).toContain("maxTokens: 4096");
});

test("generateProviderExtension 空列表生成空工厂", () => {
  const code = generateProviderExtension([]);
  // 空列表也要是合法的 extension（含 import + 工厂函数，只是不注册任何 provider）
  expect(code).toContain("export default function");
});

test("generateProviderExtension anthropic 格式正确映射", () => {
  const code = generateProviderExtension([sampleProvider({ api: "anthropic-messages" })]);
  expect(code).toContain('api: "anthropic-messages"');
});

test("ensureProviderExtensionRegistered 写 extension 文件 + settings.json packages", async () => {
  const dir = join(import.meta.dir, ".tmp-ext-" + Math.random().toString(36).slice(2));
  // 先放 providers.json 让 store 能读到
  const { ProviderStore } = await import("../src/provider-store");
  const store = new ProviderStore(join(dir, "providers.json"));
  await store.save(sampleProvider());

  await ensureProviderExtensionRegistered(dir, store);

  // extension 文件存在
  const extFile = join(GENERATED_DIR, "provider-extension.ts");
  expect(existsSync(extFile)).toBe(true);
  const code = readFileSync(extFile, "utf8");
  expect(code).toContain('registerProvider("my-deepseek"');

  // settings.json packages 含 extension 路径
  const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  expect(settings.packages).toContain(extFile);

  rmSync(dir, { recursive: true, force: true });
  rmSync(extFile, { force: true });
});

test("ensureProviderExtensionRegistered 幂等不重复写", async () => {
  const dir = join(import.meta.dir, ".tmp-ext2-" + Math.random().toString(36).slice(2));
  const { ProviderStore } = await import("../src/provider-store");
  const store = new ProviderStore(join(dir, "providers.json"));
  await store.save(sampleProvider());

  await ensureProviderExtensionRegistered(dir, store);
  await ensureProviderExtensionRegistered(dir, store);  // 二次调用

  const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  // packages 中 extension 路径只出现一次
  const extPath = join(GENERATED_DIR, "provider-extension.ts");
  const count = settings.packages.filter((p: string) => p === extPath).length;
  expect(count).toBe(1);

  rmSync(dir, { recursive: true, force: true });
  rmSync(extPath, { force: true });
});
