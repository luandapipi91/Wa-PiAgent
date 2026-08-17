import { test, expect, afterAll } from "bun:test";
import { rmSync, readFileSync, existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  slugifyProviders,
  generateProviderExtension,
  ensureProviderExtensionRegistered,
  extensionCoversProvider,
  resolveProviderBaseUrl,
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
    sampleProvider({ id: "p2", name: "My DeepSeek" }), // 同名
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

test("generateProviderExtension：内置目录有 baseUrl 时优先用内置（纠正缺 /v1 的脏数据）", () => {
  // 模拟 opencode-go：provider.baseUrl 不带 /v1，但内置目录里该模型带 /v1
  const providers = [
    sampleProvider({
      id: "p1",
      name: "OpenCode Zen Go",
      slug: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go",
      models: [
        { id: "deepseek-v4-flash", contextWindow: 1000000, maxTokens: 384000 },
      ],
    }),
  ];
  const sdkModelMap = new Map([
    [
      "opencode-go/deepseek-v4-flash",
      {
        contextWindow: 1000000,
        maxTokens: 384000,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        name: "deepseek-v4-flash",
        baseUrl: "https://opencode.ai/zen/go/v1",
        api: "openai-completions",
      },
    ],
  ]);
  const code = generateProviderExtension(providers, sdkModelMap);
  // 应使用内置目录的 /v1 baseUrl，而非 provider.baseUrl 的不带 /v1
  expect(code).toContain('baseUrl: "https://opencode.ai/zen/go/v1"');
  expect(code).not.toContain('baseUrl: "https://opencode.ai/zen/go"');
});

test("generateProviderExtension：anthropic-messages provider 不采用其他 api 分节的目录 baseUrl", () => {
  // 回归：opencode-go 的 deepseek-v4-flash 在内置目录里只挂在 openai-completions 分节
  // （baseUrl 带 /v1），provider 配的是 anthropic-messages——Anthropic SDK 会自己拼
  // /v1/messages，若沿用目录的 /v1 baseUrl 会打成 /v1/v1/messages 404。
  const providers = [
    sampleProvider({
      id: "p1",
      name: "OpenCode Zen Go",
      slug: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go",
      api: "anthropic-messages",
      models: [
        { id: "deepseek-v4-flash", contextWindow: 1000000, maxTokens: 384000 },
      ],
    }),
  ];
  const sdkModelMap = new Map([
    [
      "opencode-go/deepseek-v4-flash",
      {
        contextWindow: 1000000,
        maxTokens: 384000,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        name: "DeepSeek V4 Flash",
        baseUrl: "https://opencode.ai/zen/go/v1",
        api: "openai-completions",
      },
    ],
  ]);
  const code = generateProviderExtension(providers, sdkModelMap);
  // api 不匹配 → 回退 provider.baseUrl（不带 /v1）
  expect(code).toContain('baseUrl: "https://opencode.ai/zen/go"');
  expect(code).not.toContain('baseUrl: "https://opencode.ai/zen/go/v1"');
  // 元数据（contextWindow 等）不受 api 过滤影响，仍可用目录值
  expect(code).toContain("contextWindow: 1000000");
});

test("generateProviderExtension：同名模型跨 provider 不互相污染 baseUrl", () => {
  // deepseek 和 opencode-go 都有 deepseek-v4-flash，但 baseUrl 不同
  const deepseek = sampleProvider({
    id: "p1",
    name: "DeepSeek",
    slug: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    models: [
      { id: "deepseek-v4-flash", contextWindow: 1000000, maxTokens: 384000 },
    ],
  });
  const opencode = sampleProvider({
    id: "p2",
    name: "OpenCode Zen Go",
    slug: "opencode-go",
    baseUrl: "https://opencode.ai/zen/go",
    models: [
      { id: "deepseek-v4-flash", contextWindow: 1000000, maxTokens: 384000 },
    ],
  });
  const sdkModelMap = new Map([
    [
      "deepseek/deepseek-v4-flash",
      {
        contextWindow: 1000000,
        maxTokens: 384000,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        name: "DeepSeek V4 Flash",
        baseUrl: "https://api.deepseek.com",
        api: "openai-completions",
      },
    ],
    [
      "opencode-go/deepseek-v4-flash",
      {
        contextWindow: 1000000,
        maxTokens: 384000,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        name: "DeepSeek V4 Flash",
        baseUrl: "https://opencode.ai/zen/go/v1",
        api: "openai-completions",
      },
    ],
  ]);
  const code = generateProviderExtension([deepseek, opencode], sdkModelMap);
  // 各自用各自的 baseUrl
  expect(code).toContain('baseUrl: "https://api.deepseek.com"');
  expect(code).toContain('baseUrl: "https://opencode.ai/zen/go/v1"');
});

test("generateProviderExtension：内置目录无该模型时回退 provider.baseUrl", () => {
  const providers = [
    sampleProvider({
      id: "p1",
      name: "自定义",
      baseUrl: "https://my.custom.com/v1",
      models: [{ id: "custom-model", contextWindow: 64000, maxTokens: 4096 }],
    }),
  ];
  const code = generateProviderExtension(providers, new Map());
  expect(code).toContain('baseUrl: "https://my.custom.com/v1"');
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
  const code = generateProviderExtension(
    [sampleProvider({ api: "anthropic-messages" })],
    new Map(),
  );
  expect(code).toContain('api: "anthropic-messages"');
});

test("generateProviderExtension SDK 查不到模型时 reasoning 默认 false", () => {
  const code = generateProviderExtension([sampleProvider()], new Map());
  // SDK 找不到模型时 reasoning 默认 false（由 DEFAULT_SDK_MODEL 决定）
  expect(code).toContain("reasoning: false");
});

test("ensureProviderExtensionRegistered 写 extension 文件到指定目录", async () => {
  const dir = join(
    import.meta.dir,
    ".tmp-ext-" + Math.random().toString(36).slice(2),
  );
  const generatedDir = join(dir, "generated");
  try {
    const { ProviderStore } = await import("../src/provider-store");
    const store = new ProviderStore(join(dir, "providers.json"));
    await store.save(sampleProvider());

    await ensureProviderExtensionRegistered(store, generatedDir);

    // extension 文件生成到注入的输出目录（不触碰真实 GENERATED_DIR）
    const extFile = join(generatedDir, "provider-extension.ts");
    expect(existsSync(extFile)).toBe(true);
    const code = readFileSync(extFile, "utf8");
    expect(code).toContain('registerProvider("my-deepseek"');

    // 不再写 settings.json.packages（迁移后改由 additionalExtensionPaths 注入）
    expect(existsSync(join(dir, "settings.json"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- extensionCoversProvider：校验 extension 文件是否覆盖了子智能体所需的 provider slug ----

test("extensionCoversProvider: 文件不存在返回 false", () => {
  expect(
    extensionCoversProvider(
      join(
        GENERATED_DIR,
        "nonexistent-" + Math.random().toString(36).slice(2) + ".ts",
      ),
      "deepseek",
    ),
  ).toBe(false);
});

test("extensionCoversProvider: 空壳 extension（无 registerProvider）对任意 slug 返回 false", async () => {
  const dir = join(
    import.meta.dir,
    ".tmp-cover-" + Math.random().toString(36).slice(2),
  );
  try {
    const emptyExt = join(dir, "empty.ts");
    await mkdir(dir, { recursive: true });
    await writeFile(emptyExt, "export default function(pi){}\n", "utf8");
    expect(extensionCoversProvider(emptyExt, "deepseek")).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("extensionCoversProvider: 含目标 slug 的 registerProvider 返回 true", async () => {
  const code = generateProviderExtension([sampleProvider()], new Map()); // slug = my-deepseek
  const dir = join(
    import.meta.dir,
    ".tmp-cover2-" + Math.random().toString(36).slice(2),
  );
  try {
    const extFile = join(dir, "ext.ts");
    await mkdir(dir, { recursive: true });
    await writeFile(extFile, code, "utf8");
    expect(extensionCoversProvider(extFile, "my-deepseek")).toBe(true);
    // 其它 slug 仍返回 false
    expect(extensionCoversProvider(extFile, "openai")).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureProviderExtensionRegistered 多次调用覆盖式重写并反映最新 providers", async () => {
  const dir = join(
    import.meta.dir,
    ".tmp-ext2-" + Math.random().toString(36).slice(2),
  );
  const generatedDir = join(dir, "generated");
  try {
    const { ProviderStore } = await import("../src/provider-store");
    const store = new ProviderStore(join(dir, "providers.json"));
    await store.save(sampleProvider({ name: "First Provider" }));

    await ensureProviderExtensionRegistered(store, generatedDir);
    await ensureProviderExtensionRegistered(store, generatedDir); // 二次调用（覆盖，不报错）

    // 更新 provider 后再调用，文件内容应反映最新 providers
    await store.delete("p1");
    await store.save(sampleProvider({ id: "p2", name: "Second Provider" }));
    await ensureProviderExtensionRegistered(store, generatedDir);

    const extFile = join(generatedDir, "provider-extension.ts");
    const code = readFileSync(extFile, "utf8");
    expect(code).toContain('registerProvider("second-provider"');
    expect(code).not.toContain('registerProvider("first-provider"');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
      models: [
        { id: "deepseek-v4-pro", contextWindow: 1000000, maxTokens: 384000 },
      ],
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
    sampleProvider({ id: "p1", name: "My Custom Provider" }), // 无 slug 字段
  ]);
  expect(result[0].slug).toBe("my-custom-provider");
});

// ---- resolveProviderBaseUrl：测试连接用内置目录 baseUrl 纠正缺 /v1 的旧值 ----

function catalogModel(overrides: Record<string, unknown> = {}): any {
  return {
    provider: "opencode-go",
    id: "deepseek-v4-flash",
    baseUrl: "https://opencode.ai/zen/go/v1",
    contextWindow: 1000000,
    maxTokens: 384000,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    name: "deepseek-v4-flash",
    ...overrides,
  };
}

test("resolveProviderBaseUrl：slug 匹配内置目录，返回带 /v1 的 baseUrl（纠正缺后缀旧值）", () => {
  const url = resolveProviderBaseUrl(
    "opencode-go",
    ["deepseek-v4-flash"],
    "https://opencode.ai/zen/go",
    [catalogModel()],
  );
  expect(url).toBe("https://opencode.ai/zen/go/v1");
});

test("resolveProviderBaseUrl：同名模型跨 provider 不污染（按 slug 过滤）", () => {
  const allModels = [
    catalogModel({ provider: "deepseek", baseUrl: "https://api.deepseek.com" }),
    catalogModel({
      provider: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go/v1",
    }),
  ];
  const url = resolveProviderBaseUrl(
    "opencode-go",
    ["deepseek-v4-flash"],
    "https://opencode.ai/zen/go",
    allModels,
  );
  expect(url).toBe("https://opencode.ai/zen/go/v1");
});

test("resolveProviderBaseUrl：找不到则回退用户配置的 baseUrl（去尾斜杠）", () => {
  const url = resolveProviderBaseUrl(
    "unknown-provider",
    ["unknown-model"],
    "https://example.com/api/",
    [],
  );
  expect(url).toBe("https://example.com/api");
});

test("resolveProviderBaseUrl：传 api 时忽略其他 api 分节的目录条目", () => {
  // 内置目录按 api 分节：同 slug 下 anthropic-messages 不带 /v1、openai-completions 带 /v1
  const allModels = [
    catalogModel({
      api: "anthropic-messages",
      baseUrl: "https://opencode.ai/zen/go",
    }),
    catalogModel({
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/go/v1",
    }),
  ];
  // openai-completions 只认带 /v1 的条目
  expect(
    resolveProviderBaseUrl(
      "opencode-go",
      ["deepseek-v4-flash"],
      "https://opencode.ai/zen/go",
      allModels,
      "openai-completions",
    ),
  ).toBe("https://opencode.ai/zen/go/v1");
  // anthropic-messages 只认不带 /v1 的条目
  expect(
    resolveProviderBaseUrl(
      "opencode-go",
      ["deepseek-v4-flash"],
      "https://fallback.example.com",
      allModels,
      "anthropic-messages",
    ),
  ).toBe("https://opencode.ai/zen/go");
  // 该 api 分节没有此模型时回退用户配置
  expect(
    resolveProviderBaseUrl(
      "opencode-go",
      ["deepseek-v4-flash"],
      "https://fallback.example.com",
      [catalogModel({ api: "openai-completions" })],
      "anthropic-messages",
    ),
  ).toBe("https://fallback.example.com");
});
