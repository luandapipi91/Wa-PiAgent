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

test("generateProviderExtension 模型默认标记 reasoning: true（对话框思考 off 时才下发 thinking disabled）", () => {
  const code = generateProviderExtension([sampleProvider()]);
  // DeepSeek 思考默认 enabled。模型标 reasoning:true 后，Pi 在 thinkingLevel=off
  // 才会发送 thinking:{type:"disabled"}，对话框的"关闭思考"才真正生效。
  // 见 https://pi.dev/docs/latest/models Model Configuration / Thinking Level Map。
  expect(code).toContain("reasoning: true");
});

test("ensureProviderExtensionRegistered 写 extension 文件到 GENERATED_DIR", async () => {
  const dir = join(import.meta.dir, ".tmp-ext-" + Math.random().toString(36).slice(2));
  const { ProviderStore } = await import("../src/provider-store");
  const store = new ProviderStore(join(dir, "providers.json"));
  await store.save(sampleProvider());

  await ensureProviderExtensionRegistered(store);

  // extension 文件生成到 GENERATED_DIR
  const extFile = join(GENERATED_DIR, "provider-extension.ts");
  expect(existsSync(extFile)).toBe(true);
  const code = readFileSync(extFile, "utf8");
  expect(code).toContain('registerProvider("my-deepseek"');

  // 不再写 settings.json.packages（迁移后改由 additionalExtensionPaths 注入）
  expect(existsSync(join(dir, "settings.json"))).toBe(false);

  rmSync(dir, { recursive: true, force: true });
  rmSync(extFile, { force: true });
});

test("ensureProviderExtensionRegistered 多次调用覆盖式重写并反映最新 providers", async () => {
  const dir = join(import.meta.dir, ".tmp-ext2-" + Math.random().toString(36).slice(2));
  const { ProviderStore } = await import("../src/provider-store");
  const store = new ProviderStore(join(dir, "providers.json"));
  await store.save(sampleProvider({ name: "First Provider" }));

  await ensureProviderExtensionRegistered(store);
  await ensureProviderExtensionRegistered(store);  // 二次调用（覆盖，不报错）

  // 更新 provider 后再调用，文件内容应反映最新 providers
  await store.delete("p1");
  await store.save(sampleProvider({ id: "p2", name: "Second Provider" }));
  await ensureProviderExtensionRegistered(store);

  const extFile = join(GENERATED_DIR, "provider-extension.ts");
  const code = readFileSync(extFile, "utf8");
  expect(code).toContain('registerProvider("second-provider"');
  expect(code).not.toContain('registerProvider("first-provider"');

  rmSync(dir, { recursive: true, force: true });
  rmSync(extFile, { force: true });
});
