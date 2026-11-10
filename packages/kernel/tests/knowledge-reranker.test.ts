import { test, expect, beforeEach } from "bun:test";
import { rerankerStatus, resetRerankerForTest, prepareReranker, rerankScores } from "../src/knowledge/reranker";

beforeEach(() => resetRerankerForTest());

test("初始状态 idle；未就绪时 rerankScores 返回 null（调用方退化 hybrid）", async () => {
  expect(rerankerStatus().status).toBe("idle");
  expect(await rerankScores("定价", ["定价政策"])).toBeNull();
});

test("下载/加载失败进入 failed 并带原因", async () => {
  resetRerankerForTest({ failNextLoad: true });
  expect(await prepareReranker()).toBe(false);
  expect(rerankerStatus().status).toBe("failed");
  expect(rerankerStatus().error).toContain("reranker");
});

test("失败后 reset 回到 idle（配合 shouldRetryLoad 允许重试；不真加载避免联网）", async () => {
  resetRerankerForTest({ failNextLoad: true });
  await prepareReranker();
  expect(rerankerStatus().status).toBe("failed");
  resetRerankerForTest();
  expect(rerankerStatus().status).toBe("idle");
});

test("失败后允许重试加载（shouldRetryLoad）", async () => {
  const { shouldRetryLoad } = await import("../src/knowledge/reranker");
  expect(shouldRetryLoad("failed")).toBe(true);
  expect(shouldRetryLoad("idle")).toBe(true);
  expect(shouldRetryLoad("ready")).toBe(false);
  expect(shouldRetryLoad("downloading")).toBe(false);
});

test("parseRerankLogits：单 logit 取原值（不再恒为 1），多类取最后一列", async () => {
  const { parseRerankLogits } = await import("../src/knowledge/reranker");
  // 单 logit（ms-marco 这类 cross-encoder）：原值，且不同样本可区分
  const single = parseRerankLogits(new Float32Array([2.5, -1.2]), [2, 1]);
  expect(single[0]).toBeCloseTo(2.5, 5);
  expect(single[1]).toBeCloseTo(-1.2, 5); // Float32 精度
  // 两类：取 label=1 那一列
  const two = parseRerankLogits(new Float32Array([0.1, 0.9, 0.7, 0.3]), [2, 2]);
  expect(two[0]).toBeCloseTo(0.9, 5);
  expect(two[1]).toBeCloseTo(0.3, 5);
});
