import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KB_DB_SCHEMA_SQL } from "../src/knowledge/schema";
import { searchBM25 } from "../src/knowledge/search/bm25";
import { reciprocalRankFusion, weightedScoreFusion } from "../src/knowledge/search/fusion";
import { bigram } from "../src/memory/bigram";

let dir: string;
let db: Database;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kb-bm25-"));
  db = new Database(join(dir, "kb.db"));
  db.run(KB_DB_SCHEMA_SQL);
  const add = (id: string, text: string) => {
    db.run(
      `INSERT INTO chunks (id, file_path, file_type, content, prefix_content, content_hash, file_mtime, file_size, updated_at)
       VALUES (?, 'a.md', 'markdown', ?, ?, ?, 1, 1, 1)`,
      [id, text, text, id],
    );
    db.run(`INSERT INTO chunks_fts (body, chunk_id) VALUES (?, ?)`, [bigram(text), id]);
  };
  add("c1", "定价政策说明");
  add("c2", "退款流程说明");
  add("c3", "商品支持 GPT-4 接口接入");
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("BM25：严格 AND 命中；allowOrFallback=false 时零命中不兜底", () => {
  expect(searchBM25(db, "定价政策", 10, { allowOrFallback: false }).length).toBeGreaterThan(0);
  expect(searchBM25(db, "定价 退款", 10, { allowOrFallback: false })).toEqual([]);
  expect(searchBM25(db, "定价 退款", 10).length).toBeGreaterThan(0); // OR 兜底
});

test("BM25：中文 bigram 能命中", () => {
  const hits = searchBM25(db, "定价", 10);
  expect(hits[0].chunkId).toBe("c1");
  expect(hits[0].score).toBeGreaterThan(0); // -bm25() 已取正
});

// 已知退化（对应 T1 的 I1）：上游 preTokenizeForFTS 会把标识符切成分量词，bigram 不做这一步。
// 正文 "GPT-4" 写入 FTS 后是 "gpt"+"4" 两个 token，而查询 "GPT4" 整体就是 "gpt4" 一个 token，
// 于是无分隔符写法检索不到带连字符的原文。这里断言的就是这个「不命中」的实际行为，
// 不是「应该命中」——修它属于分词层（preTokenizeForFTS）的事，不在本任务范围。
test("BM25：标识符边界——GPT-4 正文查 GPT4 不命中（bigram 替代 preTokenizeForFTS 的已知退化）", () => {
  expect(searchBM25(db, "GPT-4", 10).map((h) => h.chunkId)).toEqual(["c3"]);
  expect(searchBM25(db, "GPT4", 10)).toEqual([]);
});

test("融合：min-max 归一 + 默认权重 0.45/0.55/双路 0.15，按分降序", () => {
  const fused = weightedScoreFusion(
    [{ chunkId: "a", score: 10 }, { chunkId: "b", score: 5 }],
    [{ chunkId: "a", score: 0.9 }, { chunkId: "c", score: 0.5 }],
  );
  expect(fused[0].chunkId).toBe("a");
  // a 两路都是最大 → min-max 归一都是 1：0.45*1 + 0.55*1 + 0.15 = 1.15
  expect(fused[0].score).toBeCloseTo(1.15, 5);
  expect(fused.map((f) => f.chunkId).sort()).toEqual(["a", "b", "c"]);
  // min-max 把各路最小值压成 0：b（BM25 最小 5）与 c（向量最小 0.5）都只剩 0 分
  expect(fused.find((f) => f.chunkId === "b")!.score).toBeCloseTo(0, 5);
  expect(fused.find((f) => f.chunkId === "c")!.score).toBeCloseTo(0, 5);
});

test("融合：单路命中不加 overlap 加成", () => {
  const fused = weightedScoreFusion(
    [{ chunkId: "a", score: 10 }, { chunkId: "b", score: 0 }],
    [],
  );
  const byId = new Map(fused.map((f) => [f.chunkId, f.score]));
  expect(byId.get("a")!).toBeCloseTo(0.45, 5); // 只有 BM25 份额
  expect(byId.get("b")!).toBeCloseTo(0, 5); // 该通道最小值被 min-max 压成 0
});

test("融合：两路都是空列表时返回空数组", () => {
  expect(weightedScoreFusion([], [])).toEqual([]);
});

test("融合：单通道全同分走 max === min 分支（归一均为 1），各得 0.45", () => {
  const fused = weightedScoreFusion(
    [{ chunkId: "a", score: 5 }, { chunkId: "b", score: 5 }],
    [],
  );
  const byId = new Map(fused.map((f) => [f.chunkId, f.score]));
  expect(fused.length).toBe(2); // 全同分不会被压成 0
  expect(byId.get("a")!).toBeCloseTo(0.45, 5);
  expect(byId.get("b")!).toBeCloseTo(0.45, 5);
});

test("融合：向量权重单独为 0.55（单路最高分只拿 vector 份额）", () => {
  const fused = weightedScoreFusion(
    [],
    [{ chunkId: "a", score: 0.9 }, { chunkId: "b", score: 0 }],
  );
  const byId = new Map(fused.map((f) => [f.chunkId, f.score]));
  expect(byId.get("a")!).toBeCloseTo(0.55, 5);
  expect(byId.get("b")!).toBeCloseTo(0, 5);
});

test("RRF：k=60，同一块在多个列表里的名次分累加", () => {
  const fused = reciprocalRankFusion([
    [{ chunkId: "a", score: 99 }, { chunkId: "b", score: 1 }], // a 第 1 名、b 第 2 名
    [{ chunkId: "b", score: 0.9 }], // b 第 1 名
  ]);
  // b = 1/(60+2) + 1/(60+1) > a = 1/(60+1)：名次分跨列表累加
  expect(fused.map((f) => f.chunkId)).toEqual(["b", "a"]);
  expect(fused[0].score).toBeCloseTo(1 / 62 + 1 / 61, 10);
  expect(fused[1].score).toBeCloseTo(1 / 61, 10);
});
