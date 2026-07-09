import { test, expect } from "bun:test";
import { slugifyProviderName, splitModelIds } from "../src/providers";

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
