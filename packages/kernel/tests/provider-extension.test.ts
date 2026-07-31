import { test, expect, afterAll } from "bun:test";
import { rmSync, readFileSync, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  slugifyProviders,
  generateProviderExtension,
  ensureProviderExtensionRegistered,
  extensionCoversProvider,
} from "../src/provider-extension";
import { GENERATED_DIR } from "@wa-pi/shared";
import type { ModelProvider } from "@wa-pi/shared";

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
  const code = generateProviderExtension(providers, new Map());
  expect(code).toContain('pi.registerProvider("my-deepseek"');
  expect(code).toContain('name: "My DeepSeek"');
  expect(code).toContain('baseUrl: "https://api.deepseek.com/v1"');
  expect(code).toContain('apiKey: "sk-xxx"');
  expect(code).toContain('api: "openai-completions"');
});

test("generateProviderExtension 包含所有模型（SDK 查找不到时使用默认参数）", () => {
  const code = generateProviderExtension([sampleProvider()], new Map());
  expect(code).toContain('id: "deepseek-chat"');
  expect(code).toContain('id: "deepseek-reasoner"');
  // SDK 找不到模型时使用默认值 128000 / 16384
  expect(code).toContain("contextWindow: 128000");
  expect(code).toContain("maxTokens: 16384");
});

test("generateProviderExtension 空列表生成空工厂", () => {
  const code = generateProviderExtension([], new Map());
  // 空列表也要是合法的 extension（含 import + 工厂函数，只是不注册任何 provider）
  expect(code).toContain("export default function");
});

test("generateProviderExtension anthropic 格式正确映射", () => {
  const code = generateProviderExtension([sampleProvider({ api: "anthropic-messages" })], new Map());
  expect(code).toContain('api: "anthropic-messages"');
});

test("generateProviderExtension SDK 查不到模型时 reasoning 默认 false", () => {
  const code = generateProviderExtension([sampleProvider()], new Map());
  // SDK 找不到模型时 reasoning 默认 false（由 DEFAULT_SDK_MODEL 决定）
  expect(code).toContain("reasoning: false");
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

// ---- extensionCoversProvider：校验 extension 文件是否覆盖了子智能体所需的 provider slug ----

test("extensionCoversProvider: 文件不存在返回 false", () => {
  expect(extensionCoversProvider(join(GENERATED_DIR, "nonexistent-" + Math.random().toString(36).slice(2) + ".ts"), "deepseek")).toBe(false);
});

test("extensionCoversProvider: 空壳 extension（无 registerProvider）对任意 slug 返回 false", async () => {
  const dir = join(import.meta.dir, ".tmp-cover-" + Math.random().toString(36).slice(2));
  const emptyExt = join(dir, "empty.ts");
  await mkdir(dir, { recursive: true });
  await writeFile(emptyExt, "export default function(pi){}\n", "utf8");
  expect(extensionCoversProvider(emptyExt, "deepseek")).toBe(false);
  rmSync(dir, { recursive: true, force: true });
});

test("extensionCoversProvider: 含目标 slug 的 registerProvider 返回 true", async () => {
  const code = generateProviderExtension([sampleProvider()], new Map());  // slug = my-deepseek
  const dir = join(import.meta.dir, ".tmp-cover2-" + Math.random().toString(36).slice(2));
  const extFile = join(dir, "ext.ts");
  await mkdir(dir, { recursive: true });
  await writeFile(extFile, code, "utf8");
  expect(extensionCoversProvider(extFile, "my-deepseek")).toBe(true);
  // 其它 slug 仍返回 false
  expect(extensionCoversProvider(extFile, "openai")).toBe(false);
  rmSync(dir, { recursive: true, force: true });
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

// ---- 预设 provider：slug 字段对齐内置 provider id（修复 Model not found 根因）----

test("slugifyProviders: provider 带 slug 字段时用 slug 而非 name 派生", () => {
  // 预设场景：name="OpenCode Zen Go"（显示名），slug="opencode-go"（内置 provider id）
  const result = slugifyProviders([
    sampleProvider({ id: "p1", name: "OpenCode Zen Go", slug: "opencode-go" }),
  ]);
  expect(result[0].slug).toBe("opencode-go");
  // 不应是从 name 派生的错误 slug
  expect(result[0].slug).not.toBe("opencode-zen-go");
});

test("generateProviderExtension: 带 slug 的 provider 生成的 extension 用 slug 注册（修复 Model not found）", () => {
  const providers = [
    sampleProvider({
      id: "p1",
      name: "OpenCode Zen Go",
      slug: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go/v1",
      models: [{ id: "deepseek-v4-pro", contextWindow: 1000000, maxTokens: 384000 }],
    }),
  ];
  const code = generateProviderExtension(providers, new Map());
  // 关键：用内置 provider id 注册，而非从 name 派生的 opencode-zen-go
  expect(code).toContain('pi.registerProvider("opencode-go"');
  expect(code).not.toContain('pi.registerProvider("opencode-zen-go"');
  // 显示名仍写入 name 字段（供 pi UI 展示）
  expect(code).toContain('name: "OpenCode Zen Go"');
});

test("slugifyProviders: 两个预设指向同一内置 slug 时第二个加后缀", () => {
  const result = slugifyProviders([
    sampleProvider({ id: "p1", name: "DeepSeek A", slug: "deepseek" }),
    sampleProvider({ id: "p2", name: "DeepSeek B", slug: "deepseek" }),
  ]);
  expect(result[0].slug).toBe("deepseek");
  expect(result[1].slug).toBe("deepseek-2");
});

test("slugifyProviders: slug 为 undefined 时 fallback 到 name 派生（向后兼容）", () => {
  const result = slugifyProviders([
    sampleProvider({ id: "p1", name: "My Custom Provider" }),  // 无 slug 字段
  ]);
  expect(result[0].slug).toBe("my-custom-provider");
});
