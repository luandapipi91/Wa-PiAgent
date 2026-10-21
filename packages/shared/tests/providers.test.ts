import { test, expect } from "bun:test";
import { isModelAvailable, resolveProviderSlug, slugifyProviderName, splitModelIds } from "../src/providers";
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
  // 纯中文移除后为空，fallback provider-<6位名字哈希>，这里只断言前缀
  const slug = slugifyProviderName("测试供应商", []);
  expect(slug.startsWith("provider-")).toBe(true);
  expect(slug.length).toBeGreaterThan("provider-".length);
});

test("slugifyProviderName 纯中文名 fallback 必须确定性（回归：随机 slug 导致发送按钮置灰）", () => {
  // 随机 fallback 会让选中模型标识（slug/id）在下次派生时失配，
  // isModelAvailable 变 false → 发送按钮永远置灰（腾讯云等纯中文名 provider）
  const a = slugifyProviderName("腾讯云", []);
  const b = slugifyProviderName("腾讯云", []);
  expect(a).toBe(b);
  // 不同名字应得到不同 fallback（哈希区分）
  expect(slugifyProviderName("阿里云", [])).not.toBe(a);
});

test("isModelAvailable: 纯中文名 provider 选中模型后可发送（回归：随机 slug 置灰）", () => {
  const providers = [makeProvider("腾讯云", ["deepseek-v4-flash"])];
  const slug = slugifyProviderName("腾讯云", []);
  expect(isModelAvailable(`${slug}/deepseek-v4-flash`, providers)).toBe(true);
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

// ===== resolveProviderSlug =====

function makeProviderWithSlug(name: string, slug: string | undefined, modelIds: string[]): ModelProvider {
  return {
    ...makeProvider(name, modelIds),
    ...(slug !== undefined ? { slug } : {}),
  };
}

test("resolveProviderSlug: slug 字段存在时直接返回该 slug（对齐内置 provider id）", () => {
  // 预设场景：name 是显示名，slug 是内置 provider key（如 opencode-go）
  const p = makeProviderWithSlug("OpenCode Zen Go", "opencode-go", ["deepseek-v4-pro"]);
  expect(resolveProviderSlug(p, [])).toBe("opencode-go");
});

test("resolveProviderSlug: slug 为 undefined 时 fallback 到 slugifyProviderName(name)", () => {
  const p = makeProviderWithSlug("My DeepSeek", undefined, ["chat"]);
  expect(resolveProviderSlug(p, [])).toBe("my-deepseek");
});

test("resolveProviderSlug: slug 为空串时也 fallback 到 name 派生", () => {
  const p = makeProviderWithSlug("OpenAI", "", ["gpt-4o"]);
  expect(resolveProviderSlug(p, [])).toBe("openai");
});

test("resolveProviderSlug: slug 与已用 slug 冲突时加后缀（与 slugifyProviderName 一致）", () => {
  const p = makeProviderWithSlug("Another", "deepseek", ["x"]);
  // 已有 provider 占了 deepseek，当前 slug 冲突 → deepseek-2
  expect(resolveProviderSlug(p, ["deepseek"])).toBe("deepseek-2");
});

test("resolveProviderSlug: slug 无冲突时不加后缀", () => {
  const p = makeProviderWithSlug("Another", "anthropic", ["claude"]);
  expect(resolveProviderSlug(p, ["deepseek"])).toBe("anthropic");
});
