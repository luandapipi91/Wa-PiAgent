import { describe, test, expect } from "bun:test";
import {
  MODE_SPECS,
  pickPrimaryMode,
  isWeakResult,
  pickNextFallback,
  extractExactSpans,
  maxCoverage,
  type SearchMode,
} from "../src/knowledge/search/modes";
import { queryTokensOf } from "../src/knowledge/search/ranking";

describe("7 种模式规格（对齐 pi-knowledge）", () => {
  test("模式集合恰好 7 种", () => {
    expect(Object.keys(MODE_SPECS).sort()).toEqual(
      ["adaptive", "deep", "fast", "hybrid", "semantic", "semantic_hybrid"].sort(),
    );
    const modes: SearchMode[] = ["hybrid", "fast", "semantic", "semantic_hybrid", "adaptive", "deep", "auto"];
    expect(modes.length).toBe(7);
  });

  test("hybrid：双路 + AND/OR + 词法锚定 + 强门控 + 块扩窗 + 候选 x2", () => {
    expect(MODE_SPECS.hybrid).toMatchObject({
      lexical: "and_or",
      semantic: true,
      lexicalAnchor: true,
      gate: "strong",
      expand: "blocks",
      candidateMultiplier: 2,
      rerank: false,
    });
  });

  test("fast：只词法、关 OR 回退、关语义、只要任一词命中、不扩窗", () => {
    expect(MODE_SPECS.fast).toMatchObject({
      lexical: "and_only",
      semantic: false,
      gate: "coverage",
      expand: "none",
      rerank: false,
    });
  });

  test("semantic：只向量、无门控、不扩窗", () => {
    expect(MODE_SPECS.semantic).toMatchObject({
      lexical: "off",
      semantic: true,
      gate: "none",
      expand: "none",
    });
  });

  test("semantic_hybrid：双路但去掉词法锚定与词法证据门（只保留分数门）", () => {
    expect(MODE_SPECS.semantic_hybrid).toMatchObject({
      lexical: "and_or",
      semantic: true,
      lexicalAnchor: false,
      gate: "score",
    });
  });

  test("adaptive：hybrid + 行窗扩窗", () => {
    expect(MODE_SPECS.adaptive).toMatchObject({ lexicalAnchor: true, gate: "strong", expand: "lines" });
  });

  test("deep：hybrid + 重排，候选 limit×3", () => {
    expect(MODE_SPECS.deep).toMatchObject({ rerank: true, candidateMultiplier: 3, gate: "strong" });
  });
});

describe("auto 主模式判据", () => {
  test("精确查找特征 → fast：引号、路径、驼峰、常量、文件名、工单号", () => {
    expect(pickPrimaryMode('"ERR_ABORTED"')).toBe("fast");
    expect(pickPrimaryMode("src/knowledge/search.ts")).toBe("fast");
    expect(pickPrimaryMode("refreshToken")).toBe("fast");
    expect(pickPrimaryMode("MAX_RETRY_COUNT")).toBe("fast");
    expect(pickPrimaryMode("settings.json")).toBe("fast");
    expect(pickPrimaryMode("KB-1234")).toBe("fast");
  });

  test("长问题或概念词 → semantic", () => {
    expect(pickPrimaryMode("登录是怎么防止会话劫持的")).toBe("semantic");
    expect(pickPrimaryMode("这个模块的架构原理是什么")).toBe("semantic");
    expect(pickPrimaryMode("how does the index pipeline handle large files")).toBe("semantic");
    expect(
      pickPrimaryMode("a b c d e f g h i j"),
    ).toBe("semantic"); // ≥10 词
  });

  test("其余 → hybrid", () => {
    expect(pickPrimaryMode("定价政策")).toBe("hybrid");
    expect(pickPrimaryMode("报销 流程单")).toBe("semantic"); // 含「流程」→ semantic（文档判据）
  });
});

describe("auto 弱结果判定与回退链", () => {
  test("空结果一律弱", () => {
    expect(isWeakResult({ mode: "hybrid", resultCount: 0, exactHit: false, coverage: 1 })).toBe(true);
  });

  test("fast：精确串没命中且 coverage<0.67 → 弱", () => {
    expect(isWeakResult({ mode: "fast", resultCount: 2, exactHit: false, coverage: 0.5 })).toBe(true);
    expect(isWeakResult({ mode: "fast", resultCount: 2, exactHit: true, coverage: 0 })).toBe(false);
    expect(isWeakResult({ mode: "fast", resultCount: 2, exactHit: false, coverage: 0.8 })).toBe(false);
  });

  test("semantic：coverage=0 → 弱", () => {
    expect(isWeakResult({ mode: "semantic", resultCount: 3, exactHit: false, coverage: 0 })).toBe(true);
    expect(isWeakResult({ mode: "semantic", resultCount: 3, exactHit: false, coverage: 0.2 })).toBe(false);
  });

  test("hybrid/adaptive 只要有结果就不算弱（门控已把关）", () => {
    expect(isWeakResult({ mode: "hybrid", resultCount: 1, exactHit: false, coverage: 0 })).toBe(false);
  });

  test("回退链：hybrid → fast → semantic → adaptive，最多 3 次尝试", () => {
    expect(pickNextFallback("hybrid", ["hybrid"])).toBe("fast");
    expect(pickNextFallback("hybrid", ["hybrid", "fast"])).toBe("semantic");
    expect(pickNextFallback("hybrid", ["hybrid", "fast", "semantic"])).toBe("adaptive");
    expect(pickNextFallback("hybrid", ["hybrid", "fast", "semantic", "adaptive"])).toBeNull();
    expect(pickNextFallback("fast", ["fast"])).toBe("hybrid");
    expect(pickNextFallback("semantic", ["semantic"])).toBe("hybrid");
    // 已尝试过的跳过
    expect(pickNextFallback("hybrid", ["hybrid", "fast"])).toBe("semantic");
  });
});

describe("精确串抽取与覆盖率", () => {
  test("抽出引号内容、路径、文件名、常量、工单号", () => {
    expect(extractExactSpans('查 "ERR_ABORTED" 的原因')).toEqual(["ERR_ABORTED"]);
    expect(extractExactSpans("看 src/knowledge/search.ts 的实现")).toContain("src/knowledge/search.ts");
    expect(extractExactSpans("refreshToken 什么时候刷新")).toContain("refreshToken");
    expect(extractExactSpans("KB-1234 这个工单")).toContain("KB-1234");
  });

  test("maxCoverage 取所有结果的最高词法覆盖率", () => {
    const tokens = queryTokensOf("定价政策说明");
    expect(maxCoverage(tokens, [{ content: "完全无关的内容" }, { content: "定价政策说明如下" }])).toBe(1);
    expect(maxCoverage(tokens, [{ content: "无关" }])).toBe(0);
  });
});
