import { test, expect } from "bun:test";
import { normalizeScores, weightedScoreFusion, FUSION_WEIGHTS } from "../src/knowledge/search/fusion";

test("相对强度归一：全等归一为 1，次强不被压成 0，空列表为空 Map", () => {
  expect(normalizeScores([]).size).toBe(0);
  expect([...normalizeScores([{ chunkId: "a", score: 5 }, { chunkId: "b", score: 5 }]).values()]).toEqual([1, 1]);
  // 小库场景：次强 6/10 必须保留相对强度（min-max 会给 0，与置信门叠加后只剩一条）
  const rel = normalizeScores([{ chunkId: "a", score: 10 }, { chunkId: "b", score: 6 }]);
  expect(rel.get("a")).toBeCloseTo(1, 5);
  expect(rel.get("b")).toBeCloseTo(0.6, 5);
});

test("加权融合：两路都命中获得 overlap 加成，权重按 0.45/0.55/0.15", () => {
  expect(FUSION_WEIGHTS).toEqual({ bm25: 0.45, vector: 0.55, overlap: 0.15 });
  const fused = weightedScoreFusion(
    [{ chunkId: "both", score: 10 }, { chunkId: "lex", score: 5 }],
    [{ chunkId: "both", score: 0.9 }, { chunkId: "vec", score: 0.1 }],
  );
  const byId = new Map(fused.map((f) => [f.chunkId, f.score]));
  // both 两路都是最大值：0.45*1 + 0.55*1 + 0.15 = 1.15
  expect(byId.get("both")!).toBeCloseTo(1.15, 5);
  // lex / vec 在各自通道都是最小值（归一 0），另一路缺席 → 0
  expect(byId.get("lex")!).toBeCloseTo(0.45 * 0.5, 5); // 5/10 = 0.5 → 0.225
  expect(byId.get("vec")!).toBeCloseTo(0.55 * (0.1 / 0.9), 5); // 0.1/0.9 相对强度
  expect(fused[0].chunkId).toBe("both");
});

test("单路命中不加 overlap 加成", () => {
  const fused = weightedScoreFusion(
    [{ chunkId: "a", score: 10 }, { chunkId: "b", score: 0 }],
    [],
  );
  const byId = new Map(fused.map((f) => [f.chunkId, f.score]));
  expect(byId.get("a")!).toBeCloseTo(0.45, 5); // 只有 BM25 份额
});
