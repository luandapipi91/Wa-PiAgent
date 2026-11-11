import { test, expect } from "bun:test";
import {
  diversifyRankedChunks,
  interleaveByFile,
  type RankedCandidate,
} from "../src/knowledge/search/diversity";

const cand = (
  id: string,
  file: string,
  score: number,
  content = id,
  lines: [number, number] = [1, 10],
): RankedCandidate => ({
  chunk: {
    id,
    kbId: "kb1",
    filePath: file,
    fileType: "markdown",
    content,
    contentHash: id,
    startLine: lines[0],
    endLine: lines[1],
    indexedAt: 1,
  },
  kbName: "库",
  ranking: {} as never,
  score,
  content,
  snippet: content,
  startLine: lines[0],
  endLine: lines[1],
  sourceChunkIds: [id],
});

test("diversity=off 或候选 ≤2 条时直通（返回原数组）", async () => {
  const list = [cand("a", "f1.md", 1), cand("b", "f2.md", 0.9)];
  expect(await diversifyRankedChunks(list, "off")).toBe(list);
  expect(await diversifyRankedChunks(list, "balanced")).toBe(list);
});

test("balanced（λ0.76）：同文件相近行块被推后，跨文件条目进来", async () => {
  const list = [
    cand("a1", "same.md", 1.0, "定价政策说明", [1, 10]),
    cand("a2", "same.md", 0.99, "定价政策说明续", [11, 20]),
    cand("b1", "other.md", 0.9, "退款政策说明", [1, 10]),
  ];
  // MMR 单步：a2 的相关度（0.9）压过 0.24 的冗余惩罚，仍排第二
  const picked = await diversifyRankedChunks(list, "balanced");
  expect(picked.map((c) => c.chunk.id)).toEqual(["a1", "a2", "b1"]);
  // 再经文件交错轮转：别的文件先露头，同文件第二块排到后面
  expect(interleaveByFile(picked, "balanced").map((c) => c.chunk.id)).toEqual(["a1", "b1", "a2"]);
});

test("strong（λ0.62）比 balanced 更早推开冗余项", async () => {
  const list = [
    cand("a1", "same.md", 1.0, "定价政策说明", [1, 10]),
    cand("a2", "same.md", 0.5, "定价政策说明续", [11, 20]),
    cand("b1", "other.md", 0.4, "退款政策说明", [1, 10]),
  ];
  expect((await diversifyRankedChunks(list, "strong")).map((c) => c.chunk.id)).toEqual([
    "a1",
    "b1",
    "a2",
  ]);
  expect((await diversifyRankedChunks(list, "balanced")).map((c) => c.chunk.id)).toEqual([
    "a1",
    "a2",
    "b1",
  ]);
});

test("向量冗余（×0.35）：同向向量把正文不同的块也推后", async () => {
  const list = [cand("a1", "a.md", 1.0, "甲"), cand("a2", "b.md", 0.75, "乙"), cand("b1", "c.md", 0.7, "丙")];
  const vectors = new Map([
    ["a1", new Float32Array([1, 0])],
    ["a2", new Float32Array([1, 0])],
  ]);
  // 无向量：无词法/行邻近重叠，a2 按相关度排第二
  expect((await diversifyRankedChunks(list, "strong")).map((c) => c.chunk.id)).toEqual([
    "a1",
    "a2",
    "b1",
  ]);
  // 有同向向量：冗余 0.35 让 a2 的分落到 b1 之下
  expect(
    (await diversifyRankedChunks(list, "strong", vectors)).map((c) => c.chunk.id),
  ).toEqual(["a1", "b1", "a2"]);
});

test("interleaveByFile：按文件轮转", () => {
  const list = [cand("a1", "a.md", 1), cand("a2", "a.md", 0.9), cand("b1", "b.md", 0.8)];
  expect(interleaveByFile(list, "balanced").map((c) => c.chunk.id)).toEqual(["a1", "b1", "a2"]);
  expect(interleaveByFile(list, "off")).toBe(list);
});
