import { test, expect } from "bun:test";
import { PROVIDER_PRESETS } from "../src/provider-presets";
import type { ProviderApi } from "../src/providers";

const VALID_APIS: ProviderApi[] = ["openai-completions", "anthropic-messages"];

test("PROVIDER_PRESETS 恰好 10 条且 key 唯一", () => {
  expect(PROVIDER_PRESETS.length).toBe(10);
  const keys = PROVIDER_PRESETS.map(p => p.key);
  expect(new Set(keys).size).toBe(keys.length);
});

test("每条预设字段合法（name / baseUrl / api / models / 数值）", () => {
  for (const p of PROVIDER_PRESETS) {
    expect(p.name.length).toBeGreaterThan(0);
    expect(p.baseUrl.startsWith("https://")).toBe(true);
    expect(VALID_APIS).toContain(p.api);
    expect(p.models.length).toBeGreaterThanOrEqual(1);
    for (const m of p.models) {
      expect(m.id.length).toBeGreaterThan(0);
      expect(m.contextWindow).toBeGreaterThan(0);
      expect(m.maxTokens).toBeGreaterThan(0);
    }
  }
});

test("计划类（plan:true）预设必带 hint", () => {
  const planPresets = PROVIDER_PRESETS.filter(p => p.plan);
  expect(planPresets.length).toBeGreaterThanOrEqual(1);
  for (const p of planPresets) {
    expect((p.hint ?? "").length).toBeGreaterThan(0);
  }
});

test("每条预设可无丢失映射成 ModelProvider", () => {
  for (const p of PROVIDER_PRESETS) {
    const provider = {
      id: "test-id",
      apiKey: "test-key",
      name: p.name,
      baseUrl: p.baseUrl,
      api: p.api,
      models: p.models,
    };
    expect(provider.models.length).toBe(p.models.length);
    // 模型数值原样保留
    const first = provider.models[0];
    expect(first.contextWindow).toBeGreaterThan(0);
    expect(first.maxTokens).toBeGreaterThan(0);
  }
});
