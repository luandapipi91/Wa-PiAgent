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

test("失败后不无限重试：再次调用直接返回 false，直到 reset", async () => {
  resetRerankerForTest({ failNextLoad: true });
  await prepareReranker();
  expect(await prepareReranker()).toBe(false);
  resetRerankerForTest();
  expect(rerankerStatus().status).toBe("idle");
});
