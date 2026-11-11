import { describe, test, expect, mock } from "bun:test";
import {
  scoreSingleRawLogit,
  rerankWithSingleRawLogit,
} from "../src/knowledge/search/reranker-logits";
import {
  resolveRerankerConfig,
  isHfRerankerConfig,
  rerankerCacheKey,
  DEFAULT_RERANKER_MODEL,
} from "../src/knowledge/search/reranker-config";

describe("单 logit 解析（上游 reranker-logits.js 语义）", () => {
  test("单 logit 原值返回（非 sigmoid）", () => {
    expect(scoreSingleRawLogit({ data: new Float32Array([2.5]) }, "m")).toBeCloseTo(2.5, 5);
  });

  test("多 logit / 非有限值 → 抛错（与上游一致）", () => {
    expect(() => scoreSingleRawLogit({ data: new Float32Array([1, 2]) }, "m")).toThrow(
      "single-logit",
    );
    expect(() => scoreSingleRawLogit({ data: new Float32Array([NaN]) }, "m")).toThrow(
      "non-finite",
    );
  });

  test("rerankWithSingleRawLogit 透传 text_pair", async () => {
    const tokenizer = mock((text: string, opts: any) => ({ text, pair: opts.text_pair }));
    const model = mock(async () => ({ logits: { data: new Float32Array([0.7]) } }));
    const out = await rerankWithSingleRawLogit(
      { text: "q", text_pair: "d" },
      tokenizer as never,
      model as never,
      "m",
    );
    expect(out[0].score).toBeCloseTo(0.7, 5);
    expect((tokenizer.mock.calls[0][1] as any).text_pair).toBe("d");
    // 上游固定 padding + truncation
    expect((tokenizer.mock.calls[0][1] as any).padding).toBe(true);
    expect((tokenizer.mock.calls[0][1] as any).truncation).toBe(true);
  });
});

describe("重排配置（上游 reranker-config.js 语义 + Wa-Pi 镜像回落）", () => {
  test("默认 hf 模型与 remote host；cache key 含模型", () => {
    const cfg = resolveRerankerConfig({} as never);
    expect(cfg.provider).toBe("hf");
    expect(cfg.model).toBe(DEFAULT_RERANKER_MODEL);
    expect(rerankerCacheKey(cfg as never)).toContain(DEFAULT_RERANKER_MODEL);
  });

  test("未设 PI_KNOWLEDGE_RERANKER_REMOTE_HOST 时回落 WA_PI_HF_ENDPOINT（补尾部斜杠）", () => {
    const cfg = resolveRerankerConfig({ WA_PI_HF_ENDPOINT: "https://mirror.example.com" } as never);
    expect(cfg.provider).toBe("hf");
    expect((cfg as { remoteHost?: string }).remoteHost).toBe("https://mirror.example.com/");
  });

  test("上游远程变量优先于 WA_PI_HF_ENDPOINT", () => {
    const cfg = resolveRerankerConfig({
      PI_KNOWLEDGE_RERANKER_REMOTE_HOST: "https://hf.example.org/",
      WA_PI_HF_ENDPOINT: "https://mirror.example.com",
    } as never);
    expect((cfg as { remoteHost?: string }).remoteHost).toBe("https://hf.example.org/");
  });

  test("模型 URL 自带 host 不被镜像回落覆盖", () => {
    const cfg = resolveRerankerConfig({
      PI_KNOWLEDGE_RERANKER: "hf:https://huggingface.co/org/model/resolve/v1/",
      WA_PI_HF_ENDPOINT: "https://mirror.example.com",
    } as never);
    expect(cfg.provider).toBe("hf");
    expect(cfg.model).toBe("org/model");
    expect((cfg as { remoteHost?: string }).remoteHost).toBe("https://huggingface.co/");
    expect((cfg as { revision: string }).revision).toBe("v1");
  });

  test("api provider 仍可解析（reranker.ts 只实现 hf 路径）", () => {
    const cfg = resolveRerankerConfig({
      PI_KNOWLEDGE_RERANKER: "api:cohere/rerank-v3",
      PI_KNOWLEDGE_RERANKER_API_KEY: "k",
    } as never);
    expect(cfg.provider).toBe("api");
    if (cfg.provider !== "api") throw new Error("unreachable");
    expect(cfg.model).toBe("cohere/rerank-v3");
    expect(cfg.apiKey).toBe("k");
    expect(cfg.format).toBe("cohere");
    expect(isHfRerankerConfig(cfg)).toBe(false);
  });

  test("isHfRerankerConfig 只认 hf 形状", () => {
    expect(isHfRerankerConfig(resolveRerankerConfig({} as never))).toBe(true);
    expect(isHfRerankerConfig({ provider: "api", model: "x", revision: "main" })).toBe(false);
    expect(isHfRerankerConfig(null)).toBe(false);
  });
});
