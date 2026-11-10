import { test, expect } from "bun:test";
import {
  MIN_HYBRID_SCORE,
  hasEnoughLexicalEvidence,
  queryCoverage,
  queryTokensOf,
  scoreChunkForQuery,
} from "../src/knowledge/search/ranking";

test("置信门常量取上游默认 0.18", () => expect(MIN_HYBRID_SCORE).toBe(0.18));

test("coverage：查询 token 在文本中的命中比例", () => {
  const tokens = queryTokensOf("定价政策退款");
  // bigram：定价/价政/政策/政退/退款 → 文本命中前三个 = 3/5
  expect(queryCoverage("定价政策说明", tokens)).toBeCloseTo(3 / 5, 5);
});

test("词法证据门：signals ≤ 1 直接放行；≤3 个 signal 要求覆盖全部", () => {
  expect(hasEnoughLexicalEvidence("任意文本", queryTokensOf("定价"))).toBe(true); // signals=1
  const t3 = queryTokensOf("定价政策"); // 定价/价政/政策 = 3 signals
  expect(hasEnoughLexicalEvidence("退款流程", t3)).toBe(false); // 0/3
  expect(hasEnoughLexicalEvidence("定价政策", t3)).toBe(true); // 3/3
});

test("长问句（signals > 3）：覆盖率 ≥ 0.34 才放行", () => {
  const tokens = queryTokensOf("定价政策说明与退款流程"); // 10 个 bigram
  expect(hasEnoughLexicalEvidence("定价政策说明", tokens)).toBe(true); // 5/10 = 0.5
  expect(hasEnoughLexicalEvidence("定价政策", tokens)).toBe(false); // 3/10 = 0.3
});

test("路径/文件名命中 query token 加分，测试文件在非测试意图下减分", () => {
  const tokens = queryTokensOf("定价政策");
  const hit = scoreChunkForQuery(0.5, { file_path: "docs/定价政策.md", file_type: "md" }, tokens);
  const plain = scoreChunkForQuery(0.5, { file_path: "docs/other.md", file_type: "md" }, tokens);
  expect(hit.adjustedScore).toBeGreaterThan(plain.adjustedScore);

  const testFile = scoreChunkForQuery(0.5, { file_path: "docs/__tests__/定价政策.md", file_type: "md" }, tokens);
  expect(testFile.adjustedScore).toBeLessThan(plain.adjustedScore);
});

test("README/quickstart 等文档意图加权", () => {
  const tokens = queryTokensOf("install quickstart");
  const readme = scoreChunkForQuery(0.5, { file_path: "docs/quickstart.md", file_type: "md" }, tokens);
  const other = scoreChunkForQuery(0.5, { file_path: "docs/changelog.md", file_type: "md" }, tokens);
  expect(readme.adjustedScore).toBeGreaterThan(other.adjustedScore);
});
