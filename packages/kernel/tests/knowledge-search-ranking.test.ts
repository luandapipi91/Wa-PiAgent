import { describe, test, expect } from "bun:test";
import { tokenizeForSearch, signalTokens } from "../src/knowledge/search/query";
import {
  scoreChunkForQuery,
  hasEnoughLexicalEvidence,
  hasAnyLexicalEvidence,
  sourceFileBoost,
  pathTokenBoost,
  basenameTokenBoost,
  normalizeFileTypeFilter,
  isTestPath,
  queryAsksForTests,
  isLocalizationPath,
} from "../src/knowledge/search/ranking";
import type { RankChunk } from "../src/knowledge/search/contracts";

const chunk = (over: Partial<RankChunk> = {}): RankChunk => ({
  id: "c1",
  kbId: "kb1",
  filePath: "docs/pricing.md",
  fileType: "markdown",
  content: "定价政策说明：按年订阅享九折。",
  contentHash: "h",
  startLine: 1,
  endLine: 10,
  indexedAt: 1,
  ...over,
});
const tokens = (q: string) => tokenizeForSearch(q);

test("file_type 别名归一", () => {
  expect(normalizeFileTypeFilter("typescript")).toBe("typescript");
  expect(normalizeFileTypeFilter("ts")).toBe("typescript");
  expect(normalizeFileTypeFilter("markdown")).toBe("markdown");
  expect(normalizeFileTypeFilter("md")).toBe("markdown");
  expect(normalizeFileTypeFilter(undefined)).toBeUndefined();
});

test("测试路径与本地化识别", () => {
  expect(isTestPath("src/a.test.ts")).toBe(true);
  // 上游意图词表是英文（assert/fixture/spec/test/testing）；tokens 先去停用词 "how"/"to"
  expect(queryAsksForTests(signalTokens(tokens("how to test")))).toBe(true);
  // 上游 isLocalizationPath 只对 json/markdown/text/toml/yaml 判定（源码文件不算本地化副本）
  expect(isLocalizationPath("locales/zh.json", "json")).toBe(true);
});

test("pathTokenBoost ≤ 0.45、basename 命中 0.32", () => {
  expect(pathTokenBoost("src/pricing/policy.ts", signalTokens(tokens("pricing")))).toBeCloseTo(0.18, 5);
  expect(basenameTokenBoost("/a/pricing.md", signalTokens(tokens("pricing")))).toBeCloseTo(0.32, 5);
  expect(pathTokenBoost("src/other.ts", signalTokens(tokens("pricing")))).toBe(0);
});

test("sourceFileBoost ≥ 0.22 时词法证据门直接放行", () => {
  // 上游只给源码文件类型算 sourceFileBoost（markdown 恒为 0）；正文与查询几乎无重叠，靠放行分支通过
  const c = chunk({ filePath: "src/定价政策.ts", fileType: "typescript", content: "与本查询无关的说明" });
  const q = signalTokens(tokens("定价政策说明"));
  expect(sourceFileBoost(c, q)).toBeGreaterThanOrEqual(0.22);
  expect(hasEnoughLexicalEvidence(c, q)).toBe(true);
});

test("覆盖率门：信号词 ≤1 直通；≤3 要求 1/n；更多要求 0.34", () => {
  expect(hasEnoughLexicalEvidence(chunk({ content: "完全无关" }), signalTokens(tokens("定价")))).toBe(true);
  const three = signalTokens(tokens("定价 政策 折扣"));
  expect(hasEnoughLexicalEvidence(chunk({ content: "定价说明" }), three)).toBe(true); // 1/3
  const many = signalTokens(tokens("定价 政策 折扣 订阅 年费 退款"));
  expect(hasEnoughLexicalEvidence(chunk({ content: "定价说明" }), many)).toBe(false); // 1/6 < 0.34
});

test("scoreChunkForQuery 返回完整 ranking 字段", () => {
  const r = scoreChunkForQuery(0.5, chunk(), signalTokens(tokens("定价政策")));
  expect(r.base_score).toBe(0.5);
  expect(r.adjusted_score).toBeGreaterThanOrEqual(0.5);
  expect(r).toMatchObject({ is_test: false, is_localization: false, test_intent: false, user_guide_intent: false, documentation_boost: 0 });
  expect(r.coverage).toBeGreaterThan(0);
});

test("中文覆盖率不为 0", () => {
  expect(hasAnyLexicalEvidence("定价政策说明", tokens("定价政策"))).toBe(true);
});
