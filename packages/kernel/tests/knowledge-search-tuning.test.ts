import { describe, test, expect } from "bun:test";
import { resolveSearchTuning, resolveSearchWindow, summarizeSearchTuning, PROFILE_DEFAULTS } from "../src/knowledge/search/tuning";

describe("检索调优（对齐上游 tuning.js）", () => {
  test("balanced 默认值逐项对齐上游", () => {
    const t = resolveSearchTuning({ query: "定价", mode: "hybrid", kbSourceTypes: ["directory"] });
    expect(t.selectedProfile).toBe("balanced");
    expect(t.defaultLimit).toBe(10);
    expect(t.snippetMaxLength).toBe(240);
    expect(t.minHybridScore).toBe(0.18);
    expect(t.candidateMin).toBe(50);
    expect(t.candidateMultiplier).toBe(12);
    expect(t.adaptiveContextLines).toBe(80);
    expect(t.adaptiveMaxContextChars).toBe(6000);
    expect(t.adaptiveNeighborTarget).toBe(5);
    expect(t.deepRerankCandidates).toBe(30);
    expect(t.deepRerankTopKMultiplier).toBe(3);
  });

  test("八个 profile 的表值齐全", () => {
    expect(Object.keys(PROFILE_DEFAULTS).sort()).toEqual([
      "balanced",
      "code",
      "docs",
      "long_context",
      "low_token",
      "precision",
      "recall",
    ]);
  });

  test("auto profile 选择：mode/view 判据", () => {
    const pick = (q: string, mode: string) =>
      resolveSearchTuning({ query: q, mode, kbSourceTypes: ["directory"] }).selectedProfile;
    expect(pick("refreshToken", "fast")).toBe("precision");
    expect(pick("ERR_ABORTED", "code")).toBe("precision");
    expect(pick("架构设计说明", "docs")).toBe("long_context");
    expect(pick("定价政策", "adaptive")).toBe("long_context");
    expect(pick("定价政策", "semantic")).toBe("recall");
    expect(pick("定价政策", "hybrid")).toBe("balanced");
    expect(pick("如何防止登录会话被劫持", "hybrid")).toBe("long_context");
    // 上游只认「流程/架構/概念/為什麼/如何/文件/規格」与英文关键词，口语化「怎么」不触发 → balanced
    expect(pick("登录是怎么防止劫持的", "hybrid")).toBe("balanced");
  });

  test("显式 profile 覆盖 auto", () => {
    const t = resolveSearchTuning({ query: "定价", mode: "hybrid", profile: "low_token", kbSourceTypes: ["directory"] });
    expect(t.selectedProfile).toBe("low_token");
    expect(t.requestedProfile).toBe("low_token");
    expect(t.defaultLimit).toBe(5);
    expect(t.snippetMaxLength).toBe(768);
    expect(t.minHybridScore).toBe(0.4);
  });

  test("环境变量 PI_KNOWLEDGE_* 覆盖并夹紧", () => {
    const saved = {
      profile: process.env.PI_KNOWLEDGE_SEARCH_PROFILE,
      limit: process.env.PI_KNOWLEDGE_SEARCH_DEFAULT_LIMIT,
    };
    // profile 名会 trim + 小写；超范围的数值被夹到区间上界
    process.env.PI_KNOWLEDGE_SEARCH_PROFILE = " docs ";
    process.env.PI_KNOWLEDGE_SEARCH_DEFAULT_LIMIT = "999999";
    try {
      const t = resolveSearchTuning({ query: "定价", mode: "hybrid", kbSourceTypes: ["directory"] });
      expect(t.requestedProfile).toBe("docs");
      expect(t.defaultLimit).toBe(50);
    } finally {
      if (saved.profile === undefined) delete process.env.PI_KNOWLEDGE_SEARCH_PROFILE;
      else process.env.PI_KNOWLEDGE_SEARCH_PROFILE = saved.profile;
      if (saved.limit === undefined) delete process.env.PI_KNOWLEDGE_SEARCH_DEFAULT_LIMIT;
      else process.env.PI_KNOWLEDGE_SEARCH_DEFAULT_LIMIT = saved.limit;
    }
  });

  test("窗口校验：limit 1-50、offset 非负、offset+limit ≤ 800", () => {
    expect(resolveSearchWindow(undefined, undefined, 10)).toEqual({ limit: 10, offset: 0 });
    expect(() => resolveSearchWindow(0, 0, 10)).toThrow("limit must be an integer from 1 to 50");
    expect(() => resolveSearchWindow(51, 0, 10)).toThrow("limit must be an integer from 1 to 50");
    expect(() => resolveSearchWindow(10, -1, 10)).toThrow("offset must be a non-negative integer");
    expect(() => resolveSearchWindow(50, 800, 10)).toThrow("must not exceed 800");
  });

  test("summarizeSearchTuning 字段齐全", () => {
    const tuning = resolveSearchTuning({ query: "定价", mode: "hybrid", kbSourceTypes: ["directory"] });
    const s = summarizeSearchTuning(tuning, 10, 120);
    expect(s).toMatchObject({
      requested_profile: "auto",
      selected_profile: "balanced",
      limit: 10,
      candidate_limit: 120,
      retrieval_limit_per_kb: 120,
      candidate_pool_truncated: false,
    });
  });
});
