import { test, expect } from "bun:test";
import { isModelAvailable, slugifyProviderName, splitModelIds } from "../src/providers";
import type { ModelProvider } from "../src/providers";

function makeProvider(name: string, modelIds: string[]): ModelProvider {
  return {
    id: name,
    name,
    baseUrl: "",
    apiKey: "",
    api: "openai-completions",
    models: modelIds.map(id => ({ id, contextWindow: 128000, maxTokens: 4096 })),
  };
}

test("slugifyProviderName 英文 + 空格", () => {
  expect(slugifyProviderName("My DeepSeek", [])).toBe("my-deepseek");
});

test("slugifyProviderName 大写转小写", () => {
  expect(slugifyProviderName("OpenAI", [])).toBe("openai");
});

test("slugifyProviderName 移除特殊字符", () => {
  expect(slugifyProviderName("My Provider! @#$", [])).toBe("my-provider");
});

test("slugifyProviderName 中文移除后 fallback", () => {
  // 纯中文移除后为空，fallback provider-<前6位随机>，这里只断言前缀
  const slug = slugifyProviderName("测试供应商", []);
  expect(slug.startsWith("provider-")).toBe(true);
  expect(slug.length).toBeGreaterThan("provider-".length);
});

test("slugifyProviderName 冲突加后缀", () => {
  expect(slugifyProviderName("My DeepSeek", ["my-deepseek"])).toBe("my-deepseek-2");
  expect(slugifyProviderName("My DeepSeek", ["my-deepseek", "my-deepseek-2"])).toBe("my-deepseek-3");
});

test("slugifyProviderName 空白 fallback", () => {
  expect(slugifyProviderName("   ", []).startsWith("provider-")).toBe(true);
});

test("splitModelIds 多个分隔", () => {
  expect(splitModelIds("a|b|c")).toEqual(["a", "b", "c"]);
});

test("splitModelIds 末尾分隔符丢弃空串", () => {
  expect(splitModelIds("a|")).toEqual(["a"]);
  expect(splitModelIds("a|b|")).toEqual(["a", "b"]);
});

test("splitModelIds 纯空白丢弃", () => {
  expect(splitModelIds("   ")).toEqual([]);
  expect(splitModelIds("a|  |b")).toEqual(["a", "b"]);
});

test("splitModelIds 去空白 trim", () => {
  expect(splitModelIds("  a  |  b  ")).toEqual(["a", "b"]);
});

test("splitModelIds 单值", () => {
  expect(splitModelIds("deepseek-chat")).toEqual(["deepseek-chat"]);
});

// ===== isModelAvailable =====

test("isModelAvailable: model 为空（null/undefined/空串）→ false", () => {
  const providers = [makeProvider("openai", ["gpt-4o"])];
  expect(isModelAvailable(null, providers)).toBe(false);
  expect(isModelAvailable(undefined, providers)).toBe(false);
  expect(isModelAvailable("", providers)).toBe(false);
});

test("isModelAvailable: providers 为空 + 残留的过期 model → false（本 bug 核心场景）", () => {
  expect(isModelAvailable("my-deepseek/deepseek-chat", [])).toBe(false);
});

test("isModelAvailable: slug/id 存在 → true", () => {
  const providers = [makeProvider("My DeepSeek", ["deepseek-chat", "deepseek-reasoner"])];
  expect(isModelAvailable("my-deepseek/deepseek-chat", providers)).toBe(true);
  expect(isModelAvailable("my-deepseek/deepseek-reasoner", providers)).toBe(true);
});

test("isModelAvailable: model id 存在但 provider slug 不匹配 → false", () => {
  const providers = [makeProvider("openai", ["gpt-4o"])];
  expect(isModelAvailable("anthropic/gpt-4o", providers)).toBe(false);
});

test("isModelAvailable: provider 在但 model id 已被删掉 → false", () => {
  const providers = [makeProvider("openai", ["gpt-4o"])];
  expect(isModelAvailable("openai/gpt-4o-mini", providers)).toBe(false);
});

test("isModelAvailable: 裸 model id（无 slug 前缀）→ false（交由 ModelSelector 升级后再校验）", () => {
  const providers = [makeProvider("openai", ["gpt-4o"])];
  expect(isModelAvailable("gpt-4o", providers)).toBe(false);
});

test("isModelAvailable: 多 provider 同名冲突时 slug 加后缀，与派生规则一致", () => {
  const providers = [
    makeProvider("My DeepSeek", ["a"]),
    makeProvider("My DeepSeek", ["b"]),
  ];
  expect(isModelAvailable("my-deepseek/a", providers)).toBe(true);
  expect(isModelAvailable("my-deepseek-2/b", providers)).toBe(true);
  expect(isModelAvailable("my-deepseek/b", providers)).toBe(false);
});
