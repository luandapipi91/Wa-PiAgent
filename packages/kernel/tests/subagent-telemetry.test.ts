import { test, expect } from "bun:test";
import {
  computeSpawnTelemetry,
  summarizeSpawnTelemetry,
  estimateTokens,
  SubagentTelemetry,
  type SpawnTelemetryInput,
} from "../src/subagent-telemetry";

function makeInput(overrides: Partial<SpawnTelemetryInput> = {}): SpawnTelemetryInput {
  return {
    agent: "Explore",
    task: "找出所有调用 X 的地方",
    isError: false,
    returnText: "结论：共 3 处调用。",
    elapsedMs: 1234,
    childUsage: {
      tokens: { input: 10000, output: 2000, cacheRead: 5000, cacheWrite: 0, total: 17000 },
      costTotal: 0.0123,
    },
    ...overrides,
  };
}

test("estimateTokens 按 chars/4 上取整", () => {
  expect(estimateTokens("")).toBe(0);
  expect(estimateTokens("abcd")).toBe(1);
  expect(estimateTokens("abcde")).toBe(2);
});

test("computeSpawnTelemetry 字段齐全且压缩率计算正确", () => {
  const rec = computeSpawnTelemetry(makeInput());
  expect(rec.type).toBe("spawn");
  expect(rec.agent).toBe("Explore");
  expect(rec.isError).toBe(false);
  expect(rec.childOutputTokens).toBe(2000);
  expect(rec.childTotalTokens).toBe(17000);
  expect(rec.costTotal).toBe(0.0123);
  expect(rec.returnChars).toBe("结论：共 3 处调用。".length);
  expect(rec.returnTokensEst).toBe(estimateTokens("结论：共 3 处调用。"));
  expect(rec.savingsTokensEst).toBe(2000 - rec.returnTokensEst);
  expect(rec.compressionRatio).toBeCloseTo(rec.returnTokensEst / 2000);
  expect(rec.hasOutput).toBe(true);
  expect(rec.elapsedMs).toBe(1234);
});

test("无 childUsage 时降级：token 为 0，压缩率为 1，不报错", () => {
  const rec = computeSpawnTelemetry(makeInput({ childUsage: undefined }));
  expect(rec.childOutputTokens).toBe(0);
  expect(rec.childTotalTokens).toBe(0);
  expect(rec.costTotal).toBe(0);
  expect(rec.compressionRatio).toBe(1);
  expect(rec.savingsTokensEst).toBe(0);
});

test("返回值长于子代理输出时 savings 下限为 0", () => {
  const rec = computeSpawnTelemetry(makeInput({
    returnText: "x".repeat(40000),
    childUsage: { tokens: { input: 0, output: 100, cacheRead: 0, cacheWrite: 0, total: 100 }, costTotal: 0 },
  }));
  expect(rec.savingsTokensEst).toBe(0);
  expect(rec.compressionRatio).toBeGreaterThan(1);
});

test("空返回 hasOutput 为 false", () => {
  const rec = computeSpawnTelemetry(makeInput({ returnText: "   " }));
  expect(rec.hasOutput).toBe(false);
});

test("summarizeSpawnTelemetry 空记录全零", () => {
  const s = summarizeSpawnTelemetry([]);
  expect(s.spawnCount).toBe(0);
  expect(s.successRate).toBe(0);
  expect(s.aggregateCompressionRatio).toBe(1);
  expect(s.totalCost).toBe(0);
});

test("summarizeSpawnTelemetry 多条汇总：成功率与加权压缩率", () => {
  const records = [
    computeSpawnTelemetry(makeInput()), // 成功，output 2000
    computeSpawnTelemetry(makeInput({ isError: true, returnText: "" })), // 失败
    computeSpawnTelemetry(makeInput({
      childUsage: { tokens: { input: 0, output: 1000, cacheRead: 0, cacheWrite: 0, total: 1000 }, costTotal: 0.01 },
    })), // 成功，output 1000
  ];
  const s = summarizeSpawnTelemetry(records);
  expect(s.spawnCount).toBe(3);
  expect(s.usefulSpawnCount).toBe(2);
  expect(s.successRate).toBeCloseTo(2 / 3);
  expect(s.totalChildOutputTokens).toBe(5000);
  expect(s.totalCost).toBeCloseTo(0.0123 * 2 + 0.01);
  const expectedRatio = s.totalReturnTokensEst / 5000;
  expect(s.aggregateCompressionRatio).toBeCloseTo(expectedRatio);
});

test("SubagentTelemetry 收集器：record 累积，summary 汇总", () => {
  const t = new SubagentTelemetry();
  expect(t.records.length).toBe(0);
  t.record(makeInput());
  t.record(makeInput({ isError: true }));
  expect(t.records.length).toBe(2);
  expect(t.summary.spawnCount).toBe(2);
  expect(t.summary.usefulSpawnCount).toBe(1);
});
