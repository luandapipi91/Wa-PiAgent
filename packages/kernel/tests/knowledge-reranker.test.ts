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

test("下载进度聚合：按文件 loaded/total 累加，单调不回退且封顶 99", async () => {
  const { aggregateDownloadProgress } = await import("../src/knowledge/reranker");
  const files = new Map<string, { loaded: number; total: number }>();
  // 第一个文件开始：0%
  aggregateDownloadProgress(files, { status: "initiate", file: "config.json" });
  expect(aggregateDownloadProgress(files, { status: "progress", file: "config.json", loaded: 0, total: 100 })).toBe(0);
  // 一半
  expect(aggregateDownloadProgress(files, { status: "progress", file: "config.json", loaded: 50, total: 100 })).toBe(50);
  // 第二个文件加入：总量变大，百分比允许回退到真实值
  aggregateDownloadProgress(files, { status: "initiate", file: "model.onnx" });
  aggregateDownloadProgress(files, { status: "progress", file: "model.onnx", loaded: 0, total: 300 });
  expect(aggregateDownloadProgress(files, { status: "progress", file: "config.json", loaded: 100, total: 100 })).toBe(25);
  // 完成态把该文件记满
  aggregateDownloadProgress(files, { status: "done", file: "config.json" });
  expect(aggregateDownloadProgress(files, { status: "progress", file: "model.onnx", loaded: 300, total: 300 })).toBe(99);
});

test("下载进度回调接到 prepareReranker：回调触发时状态为 downloading 且 progress 更新", async () => {
  // 用注入的 fake loader 走真实加载路径（不联网）：回调由 loader 触发
  const { setRerankerLoaderForTest } = await import("../src/knowledge/reranker");
  // 用可控闸门挂住加载，好在「下载中」这一刻断言状态
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  setRerankerLoaderForTest(async (onProgress) => {
    onProgress?.({ status: "initiate", file: "config.json" });
    onProgress?.({ status: "progress", file: "config.json", loaded: 40, total: 100 });
    await gate;
    return { tokenizer: async () => ({}), model: async () => ({ logits: { data: new Float32Array([0]), dims: [1, 1] } }) };
  });
  const p = prepareReranker();
  await new Promise((r) => setTimeout(r, 10));
  expect(rerankerStatus().status).toBe("downloading");
  expect(rerankerStatus().progress).toBe(40);
  release();
  expect(await p).toBe(true);
  expect(rerankerStatus().status).toBe("ready");
  expect(rerankerStatus().progress).toBeUndefined();
});

// ============ 上游签名 rerank(query, candidates, topK, signal) ============

/** 假 pipeline：content 当分数（"3" → logit 3），tokenizer 回显 text_pair 供断言 */
function fakeRerankPipeline() {
  return {
    tokenizer: (text: string | string[], opts?: Record<string, unknown>) => ({ text, pair: opts?.text_pair }),
    model: async (inputs: unknown) => ({
      logits: { data: new Float32Array([Number((inputs as { pair: string }).pair)]), dims: [1, 1] },
    }),
  };
}

test("rerank：未就绪返回空数组（不触发加载，调用方退化 hybrid）", async () => {
  const { rerank } = await import("../src/knowledge/reranker");
  expect(await rerank("定价", [{ chunkId: "a", content: "x" }], 5)).toEqual([]);
  expect(rerankerStatus().status).toBe("idle");
});

test("rerank：按分降序并截断 topK，text_pair 传候选正文", async () => {
  const { rerank, setRerankerLoaderForTest } = await import("../src/knowledge/reranker");
  const pairs: string[] = [];
  const base = fakeRerankPipeline();
  setRerankerLoaderForTest(async () => ({
    tokenizer: (text: string | string[], opts?: Record<string, unknown>) => {
      pairs.push(String(opts?.text_pair));
      return base.tokenizer(text, opts);
    },
    model: base.model,
  }));
  await prepareReranker();
  const out = await rerank(
    "定价",
    [
      { chunkId: "a", content: "1.5" },
      { chunkId: "b", content: "3" },
      { chunkId: "c", content: "2" },
    ],
    2,
  );
  expect(out.map((r) => r.chunkId)).toEqual(["b", "c"]);
  expect(out[0].score).toBeCloseTo(3, 5);
  // 全部候选都打分（截断发生在打分之后），正文按 text_pair 逐条送入
  expect(pairs).toEqual(["1.5", "3", "2"]);
});

test("rerank：候选为空直接返回空数组（不解析配置、不加载）", async () => {
  const { rerank } = await import("../src/knowledge/reranker");
  expect(await rerank("定价", [], 5)).toEqual([]);
});

test("rerank：signal 已取消 → 抛 Cancelled（不吞成空结果）", async () => {
  const { rerank, setRerankerLoaderForTest } = await import("../src/knowledge/reranker");
  setRerankerLoaderForTest(async () => fakeRerankPipeline());
  await prepareReranker();
  const controller = new AbortController();
  controller.abort();
  await expect(
    rerank("定价", [{ chunkId: "a", content: "1" }], 5, controller.signal),
  ).rejects.toThrow("Cancelled");
});

test("rerank：api provider 抛明确的未支持错误", async () => {
  const { rerank } = await import("../src/knowledge/reranker");
  const prev = process.env.PI_KNOWLEDGE_RERANKER;
  process.env.PI_KNOWLEDGE_RERANKER = "api:cohere/rerank-v3";
  try {
    await expect(rerank("q", [{ chunkId: "a", content: "x" }], 5)).rejects.toThrow("未支持");
  } finally {
    if (prev === undefined) delete process.env.PI_KNOWLEDGE_RERANKER;
    else process.env.PI_KNOWLEDGE_RERANKER = prev;
  }
});
