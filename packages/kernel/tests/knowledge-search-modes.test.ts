import { describe, test, expect } from "bun:test";
import {
  SEARCH_MODES,
  retrievalModeFor,
  matchReasonFor,
  isExactLookupQuery,
  chooseAutoMode,
  fallbackModesFor,
  isWeakAutoResponse,
  type SearchMode,
} from "../src/knowledge/search/modes";

test("12 个对外 mode 取值", () => {
  const expected: SearchMode[] = ["adaptive", "auto", "code", "config", "decision", "deep", "docs", "errors", "fast", "hybrid", "semantic", "semantic_hybrid"];
  expect([...SEARCH_MODES].sort()).toEqual(expected.sort());
});

test("别名映射到检索策略", () => {
  expect(retrievalModeFor("auto")).toBe("hybrid");
  expect(retrievalModeFor("code")).toBe("fast");
  expect(retrievalModeFor("config")).toBe("fast");
  expect(retrievalModeFor("errors")).toBe("fast");
  expect(retrievalModeFor("docs")).toBe("hybrid");
  expect(retrievalModeFor("decision")).toBe("hybrid");
  expect(retrievalModeFor("semantic_hybrid")).toBe("semantic_hybrid");
});

test("match_reason（provenance 用）", () => {
  expect(matchReasonFor("deep")).toBe("rerank");
  expect(matchReasonFor("adaptive")).toBe("adaptive");
  expect(matchReasonFor("semantic")).toBe("vector");
  expect(matchReasonFor("fast")).toBe("bm25");
  expect(matchReasonFor("errors")).toBe("bm25");
  expect(matchReasonFor("hybrid")).toBe("hybrid");
});

test("精确查找判据", () => {
  expect(isExactLookupQuery('"ERR_ABORTED"')).toBe(true);
  expect(isExactLookupQuery("src/knowledge/search.ts")).toBe(true);
  // 上游驼峰正则要求首字母大写：小驼峰 refreshToken 不算精确查找
  expect(isExactLookupQuery("refreshToken")).toBe(false);
  expect(isExactLookupQuery("RefreshToken")).toBe(true);
  expect(isExactLookupQuery("MAX_RETRY")).toBe(true);
  expect(isExactLookupQuery("KB-1234")).toBe(true);
  expect(isExactLookupQuery("定价政策")).toBe(false);
});

test("auto 主模式", () => {
  // refreshToken 不是精确查找（见上），1 词且无概念词 → hybrid
  expect(chooseAutoMode("refreshToken")).toBe("hybrid");
  expect(chooseAutoMode('"ERR_ABORTED"')).toBe("fast");
  expect(chooseAutoMode("定价政策")).toBe("hybrid");
  // 上游概念词表只有「流程 / 架構 / 概念 / 為什麼 / 如何」，不含「怎么」「为什么」「架构」
  expect(chooseAutoMode("登录是怎么防止劫持的")).toBe("hybrid");
  expect(chooseAutoMode("这个模块的架构原理是什么")).toBe("hybrid");
  expect(chooseAutoMode("如何配置语义检索")).toBe("semantic");
  expect(chooseAutoMode("a b c d e f g h i j")).toBe("semantic");
});

test("回退链（上游 fallbackModesFor）", () => {
  expect(fallbackModesFor("fast")).toEqual(["hybrid", "semantic"]);
  expect(fallbackModesFor("semantic")).toEqual(["hybrid", "adaptive"]);
  expect(fallbackModesFor("adaptive")).toEqual(["hybrid", "deep"]);
  expect(fallbackModesFor("deep")).toEqual(["hybrid", "adaptive"]);
  expect(fallbackModesFor("hybrid")).toEqual(["fast", "semantic", "adaptive"]);
});

test("弱结果判定（上游 isWeakAutoResponse）", () => {
  const resp = (n: number, coverage = 0, file = "a.md", content = "x") => ({
    results: Array.from({ length: n }, () => ({ file_path: file, content, ranking: { coverage } })),
  });
  expect(isWeakAutoResponse("定价", resp(0), "hybrid", "hybrid")).toBe(true);
  expect(isWeakAutoResponse('"ERR_ABORTED"', resp(1, 0.1, "a.ts", "其他内容"), "fast", "fast")).toBe(true);
  expect(isWeakAutoResponse('"ERR_ABORTED"', resp(1, 0, "a.ts", "ERR_ABORTED 出现"), "fast", "fast")).toBe(false);
  expect(isWeakAutoResponse("定价", resp(1, 0), "hybrid", "semantic")).toBe(true);
  expect(isWeakAutoResponse("定价", resp(1, 0.3), "hybrid", "semantic")).toBe(false);
});
