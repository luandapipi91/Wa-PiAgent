import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KB_SCHEMA_SQL } from "../src/knowledge/schema";
import { KnowledgeStore } from "../src/knowledge/store";
import { closeAllKbDbs, openKbDb } from "../src/knowledge/kb-db";
import { refreshKbQuantizedIndex } from "../src/knowledge/vector";
import { searchKnowledge, type SearchOptions } from "../src/knowledge/search";
import type { KbContext } from "../src/knowledge/index";
import { bigram } from "../src/memory/bigram";
import { EMBED_DIM } from "../src/memory/schema";

// 知识库检索编排测试：fake 向量手工插块建库（不经模型、不经 indexer）。
// 向量用正交单位向量造两簇：簇 A（e0）/ 簇 B（e1），量化距离 = 1 − 余弦，
// 同簇 ≈0（过 0.75 门），跨簇 ≈1（被门拦）。查询向量经 opts.embedQueryFn 注入
//（同 indexer 的 EmbedFn 注入模式），避免 mock.module 泄漏；null 即「模型不可用 → 语义禁用」。

/** number[] → 落库/查询向量字节（Float32 小端，与 embedder 同格式） */
function pack(values: number[]): Uint8Array {
  return new Uint8Array(new Float32Array(values).buffer);
}

/** 第 i 维为 1 的单位向量 */
function unitVec(i: number): number[] {
  const v = new Array<number>(EMBED_DIM).fill(0);
  v[i] = 1;
  return v;
}

const VEC_A = unitVec(0);
const VEC_B = unitVec(1);

type FakeEmbedQuery = (text: string) => Promise<Uint8Array | null>;

/** 固定向量注入器；null = 模型不可用 */
function fakeEmbedQuery(vec: number[] | null, counter?: { n: number }): FakeEmbedQuery {
  return async () => {
    if (counter) counter.n++;
    return vec ? pack(vec) : null;
  };
}

let waPiDir: string;
let reg: Database;
let store: KnowledgeStore;
let ctx: KbContext;

beforeEach(() => {
  waPiDir = mkdtempSync(join(tmpdir(), "kb-search-wapidir-"));
  reg = new Database(join(waPiDir, "knowledge.db"));
  reg.run(KB_SCHEMA_SQL);
  store = new KnowledgeStore(reg, waPiDir);
  ctx = { store, waPiDir, sse: () => {} };
});

afterEach(() => {
  closeAllKbDbs(); // 每库连接归缓存所有，用例间必须归位
  reg.close();
  rmSync(waPiDir, { recursive: true, force: true });
});

interface FakeChunk {
  content: string;
  /** FTS 双写的正文（默认 = content）：用于让词法命中与正文文本解耦 */
  prefixContent?: string;
  title?: string | null;
  breadcrumb?: string | null;
  filePath?: string;
  fileType?: string;
  startLine?: number | null;
  endLine?: number | null;
  vec?: Uint8Array;
  /** 索引时记录的源文件 mtime（缺省 1：与磁盘上任何真实文件都对不上） */
  fileMtime?: number;
}

/** 手工插块：chunks 行 + FTS 双写（body = bigram(prefixContent)，与 indexer 写入格式一致） */
function insertChunk(db: Database, c: FakeChunk): string {
  const id = randomUUID();
  const prefixContent = c.prefixContent ?? c.content;
  db.run(
    `INSERT INTO chunks (id, file_path, file_type, title, breadcrumb, start_line, end_line,
       content, prefix_content, content_hash, file_mtime, file_size, embedding, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [
      id,
      c.filePath ?? "docs/doc.md",
      c.fileType ?? "md",
      c.title ?? null,
      c.breadcrumb ?? null,
      c.startLine ?? null,
      c.endLine ?? null,
      c.content,
      prefixContent,
      randomUUID(),
      c.fileMtime ?? 1,
      c.vec ?? null,
      Date.now(),
    ],
  );
  db.run(`INSERT INTO chunks_fts (body, chunk_id) VALUES (?, ?)`, [bigram(prefixContent), id]);
  return id;
}

/** 建一个登记库并手工插块（不经 indexer/模型），返回 kbId（默认置 ready） */
function setupKb(name: string, chunks: FakeChunk[]): string {
  const kbId = store.createKb({ folderPath: waPiDir, name }).id;
  const db = openKbDb(waPiDir, kbId);
  try {
    for (const c of chunks) insertChunk(db, c);
    // 量化索引不刷新语义通道扫不到（shadow table 依赖显式重建，同 memory）
    refreshKbQuantizedIndex(db);
  } finally {
    db.close();
  }
  // 计数器对齐真实索引产物（空库会被静默跳过，检索用例不能留 chunkCount=0）
  store.updateStatus(kbId, "ready", {
    fileCount: new Set(chunks.map((c) => c.filePath ?? "docs/doc.md")).size,
    chunkCount: chunks.length,
    lastIndexedAt: Date.now(),
  });
  return kbId;
}

/** 统一走新签名 */
function search(
  kbIds: string[],
  query: string,
  opts: SearchOptions = {},
): ReturnType<typeof searchKnowledge> {
  return searchKnowledge(ctx, kbIds, query, opts);
}

// ============ 基础召回与出处 ============

test("中文查询经 bigram 命中（词法通道中文可用）", async () => {
  const kbId = setupKb("产品手册", [
    {
      content: "本产品的定价政策如下：按年订阅享九折。",
      title: "定价",
      breadcrumb: "产品 > 定价",
      filePath: "docs/pricing.md",
      startLine: 1,
      endLine: 12,
    },
    { content: "退款流程需要提交工单。", title: "退款", filePath: "docs/refund.md" },
  ]);
  // 查询向量 null = 模型不可用：语义通道禁用，纯词法也要命中
  const r = await search([kbId], "定价政策", { limit: 5, embedQueryFn: fakeEmbedQuery(null) });
  expect(r.found).toBe(true);
  expect(r.results.length).toBeGreaterThan(0);
  expect(r.results[0].title).toBe("定价");
  expect(r.modeUsed).toBe("hybrid");
});

test("结果带出处：file_path/file_type/title/lines/kb_name/score/ranking", async () => {
  const kbId = setupKb("产品手册", [
    {
      content: "定价政策说明：按年订阅享九折优惠。",
      title: "定价",
      filePath: "docs/pricing.md",
      startLine: 3,
      endLine: 18,
    },
    {
      content: "定价政策的历史版本存档说明。",
      title: "定价历史",
      filePath: "docs/pricing-history.md",
      startLine: 20,
      endLine: 30,
    },
    { content: "完全不相关的条目内容。", title: "其他", filePath: "docs/other.md" },
  ]);
  const r = await search([kbId], "定价政策", { limit: 5, embedQueryFn: fakeEmbedQuery(null) });
  // 纯词法场景（模型不可用）：min-max 归一后最弱命中归 0 过不了分数门，
  // 因此每库最多留 2 条；不钉死条数，只断言不变量。
  expect(r.results.length).toBeGreaterThanOrEqual(1);
  expect(r.results.length).toBeLessThanOrEqual(2);
  for (const h of r.results) {
    expect(typeof h.kbId).toBe("string");
    expect(h.kbName).toBe("产品手册");
    expect(typeof h.content).toBe("string");
    expect(typeof h.filePath).toBe("string");
    expect(h.fileType).toBe("markdown");
    expect(typeof h.score).toBe("number");
    expect(Number.isFinite(h.score)).toBe(true);
    expect(h.score).toBeGreaterThan(0);
    expect(h.ranking.coverage).toBeGreaterThan(0);
    expect(h.snippet.length).toBeGreaterThan(0);
  }
  // 出处字段逐块回读自洽（哪块排第一由 bm25 决定，不钉死顺序）
  const metaByTitle = new Map([
    ["定价", { filePath: "docs/pricing.md", startLine: 3, endLine: 18 }],
    ["定价历史", { filePath: "docs/pricing-history.md", startLine: 20, endLine: 30 }],
  ]);
  for (const h of r.results) {
    const meta = metaByTitle.get(h.title!);
    expect(meta).toBeDefined();
    expect(h.filePath).toBe(meta!.filePath);
    expect(h.startLine).toBe(meta!.startLine);
    expect(h.endLine).toBe(meta!.endLine);
  }
});

test("provenance：chunk_id/chunk_hash/indexed_at/match_reason/stale/source_chunk_ids", async () => {
  const kbId = setupKb("出处库", [{ content: "定价政策说明。", title: "t" }]);
  const r = await search([kbId], "定价政策", {
    limit: 10,
    embedQueryFn: fakeEmbedQuery(null),
    // 源文件不在磁盘上会判 stale；本用例只锁 provenance 形状，注入与记录一致的 stat
    statFn: async () => ({ mtimeMs: 1 }),
  });
  const hit = r.results[0];
  expect(hit.provenance.chunk_id).toBeTruthy();
  expect(hit.provenance.chunk_hash).toBeTruthy();
  expect(hit.provenance.indexed_at).toBeGreaterThan(0);
  expect(hit.provenance.match_reason).toBe("hybrid");
  expect(typeof hit.provenance.stale).toBe("boolean");
  expect(hit.provenance.source_chunk_ids).toEqual([hit.provenance.chunk_id]);
  // 顶层 stale 仅在陈旧时出现（正常结果不加噪声）
  expect(hit.stale).toBeUndefined();
});

// ============ 模式语义（对齐 pi-knowledge）============

test("hybrid：词法锚定——BM25 零命中时整库跳过并给 warning", async () => {
  const kbId = setupKb("锚定库", [{ content: "苹果香蕉价格分析。", vec: pack(VEC_A) }]);
  const r = await search([kbId], "量子通信技术", { limit: 10, embedQueryFn: fakeEmbedQuery(VEC_A) });
  expect(r.results).toEqual([]);
  expect(r.found).toBe(false);
  expect(r.warnings?.some((w) => w.includes("no lexical match"))).toBe(true);
  expect(r.skippedKbs).toContainEqual({ kbId, reason: "lexical_anchor" });
});

test("semantic：纯向量命中，无词法锚定", async () => {
  const kbId = setupKb("语义库", [
    { content: "苹果香蕉价格分析。", title: "水果", vec: pack(VEC_A) },
    { content: "桌椅木料工艺记录。", title: "木工", vec: pack(VEC_B) },
  ]);
  const r = await search([kbId], "量子通信技术", {
    limit: 10,
    mode: "semantic",
    embedQueryFn: fakeEmbedQuery(VEC_A),
  });
  expect(r.results[0].title).toBe("水果");
  expect(r.modeUsed).toBe("semantic");
  expect(r.results[0].provenance.match_reason).toBe("vector");
  // 簇 B 与查询向量正交（距离≈1 > 0.75 门）：被距离门拦住，不许低分凑数
  expect(r.results.some((h) => h.title === "木工")).toBe(false);
});

test("semantic_hybrid：去掉词法锚定与词法证据门，纯语义命中也能进结果", async () => {
  const kbId = setupKb("半语义库", [
    { content: "苹果和香蕉的价格走势分析。", title: "水果", vec: pack(VEC_A) },
  ]);
  const r = await search([kbId], "量子通信技术", {
    limit: 5,
    mode: "semantic_hybrid",
    embedQueryFn: fakeEmbedQuery(VEC_A),
  });
  expect(r.found).toBe(true);
  expect(r.modeUsed).toBe("semantic_hybrid");
  expect(r.results[0].title).toBe("水果");
  expect(r.results[0].provenance.match_reason).toBe("hybrid");
});

test("fast：严格短语零命中不兜底（hybrid 会 OR 兜底命中）", async () => {
  const kbId = setupKb("严格库", [{ content: "定价政策说明。", title: "定价" }]);
  const fast = await search([kbId], "定价 报销", {
    limit: 10,
    mode: "fast",
    embedQueryFn: fakeEmbedQuery(null),
  });
  const hy = await search([kbId], "定价 报销", {
    limit: 10,
    embedQueryFn: fakeEmbedQuery(null),
  });
  expect(fast.modeUsed).toBe("fast");
  expect(fast.results).toEqual([]);
  expect(fast.found).toBe(false);
  expect(hy.found).toBe(true); // OR 兜底，「定价」命中即召回
});

test("fast：短路不做融合——同一库两条词法命中都保留（min-max 不会压成一条）", async () => {
  const kbId = setupKb("快查多命库", [
    { content: "定价政策甲说明。", title: "甲", filePath: "docs/a.md" },
    { content: "定价政策乙说明。", title: "乙", filePath: "docs/b.md" },
  ]);
  const r = await search([kbId], "定价政策", {
    limit: 10,
    mode: "fast",
    embedQueryFn: fakeEmbedQuery(null),
  });
  expect(r.results.map((h) => h.title).sort()).toEqual(["乙", "甲"].sort());
});

test("fast：命中时不扩窗（只给命中块原文）", async () => {
  const kbId = setupKb("快查库", [
    { content: "定价政策说明。", title: "定价", filePath: "docs/a.md", startLine: 1, endLine: 10 },
    { content: "退款流程说明。", title: "退款", filePath: "docs/a.md", startLine: 11, endLine: 20 },
  ]);
  const r = await search([kbId], "定价政策", {
    limit: 5,
    mode: "fast",
    embedQueryFn: fakeEmbedQuery(null),
  });
  expect(r.results[0].content).toBe("定价政策说明。");
});

test("mode=code 别名：行为等价 fast，但 modeUsed 保留入参别名", async () => {
  const kbId = setupKb("代码库", [
    { content: "refreshToken 刷新逻辑在 auth/session.ts 里。", title: "会话", vec: pack(VEC_A) },
    { content: "定价政策说明。", title: "定价", vec: pack(VEC_B) },
  ]);
  const fast = await search([kbId], "refreshToken", {
    limit: 5,
    mode: "fast",
    embedQueryFn: fakeEmbedQuery(VEC_A),
  });
  const code = await search([kbId], "refreshToken", {
    limit: 5,
    mode: "code",
    embedQueryFn: fakeEmbedQuery(VEC_A),
  });
  expect(code.results.map((h) => [h.title, h.score])).toEqual(
    fast.results.map((h) => [h.title, h.score]),
  );
  expect(code.modeUsed).toBe("code");
  expect(code.results[0].provenance.match_reason).toBe("bm25");
});

test("mode=errors 别名：modeUsed=errors 且 match_reason=bm25", async () => {
  const kbId = setupKb("排错库", [{ content: "ENOENT：定价政策配置缺失。", title: "排错" }]);
  const r = await search([kbId], "定价政策", {
    limit: 5,
    mode: "errors",
    embedQueryFn: fakeEmbedQuery(null),
  });
  expect(r.modeUsed).toBe("errors");
  expect(r.results[0].provenance.match_reason).toBe("bm25");
});

test("mode=docs 别名：行为等价 hybrid，modeUsed 保留 docs", async () => {
  const kbId = setupKb("文档库", [
    { content: "定价政策说明：按年订阅享九折优惠。", title: "定价", vec: pack(VEC_A) },
    { content: "退款流程需要提交工单。", title: "退款", vec: pack(VEC_B) },
  ]);
  const hybrid = await search([kbId], "定价政策", {
    limit: 5,
    mode: "hybrid",
    embedQueryFn: fakeEmbedQuery(VEC_A),
  });
  const docs = await search([kbId], "定价政策", {
    limit: 5,
    mode: "docs",
    embedQueryFn: fakeEmbedQuery(VEC_A),
  });
  expect(docs.results.map((h) => [h.title, h.score])).toEqual(
    hybrid.results.map((h) => [h.title, h.score]),
  );
  expect(docs.modeUsed).toBe("docs");
  expect(docs.results[0].provenance.match_reason).toBe("hybrid");
});

test("全部库零命中返回 found:false 而非低分凑数", async () => {
  const kbId = setupKb("产品手册", [
    { content: "定价政策说明。", title: "定价", vec: pack(VEC_A) },
  ]);
  // 词法零重叠 + 语义向量正交（距离≈1 > 0.75 门被拦）
  const r = await search([kbId], "完全不相关的量子术语", {
    limit: 5,
    embedQueryFn: fakeEmbedQuery(VEC_B),
  });
  expect(r.found).toBe(false);
  expect(r.results).toEqual([]);
  expect(r.totalCount).toBe(0);
  expect(r.hasMore).toBe(false);
});

// ============ 调优窗口：分页与过滤 ============

test("分页：total_count/has_more/offset 语义", async () => {
  const kbId = setupKb(
    "分页库",
    Array.from({ length: 25 }, (_, i) => ({
      content: `定价政策第${i}条说明。`,
      title: `t${i}`,
      filePath: `docs/p${i}.md`,
    })),
  );
  const r1 = await search([kbId], "定价政策", {
    limit: 10,
    offset: 0,
    embedQueryFn: fakeEmbedQuery(null),
  });
  const r2 = await search([kbId], "定价政策", {
    limit: 10,
    offset: 10,
    embedQueryFn: fakeEmbedQuery(null),
  });
  expect(r1.results.length).toBe(10);
  expect(r1.hasMore).toBe(true);
  expect(r2.results.length).toBe(10);
  expect(r1.totalCount).toBe(r2.totalCount);
  expect(r1.totalCount).toBeGreaterThanOrEqual(20);
  expect(r2.results[0].title).not.toBe(r1.results[0].title);
});

test("过滤：path_pattern 只保留匹配路径（过滤在截断前）", async () => {
  const kbId = setupKb("过滤库", [
    { content: "定价政策说明。", title: "md", filePath: "docs/a.md" },
    {
      // 重复查询词抬高 BM25，保证它过分数门后才被路径过滤选中
      content: "定价政策 定价政策 定价政策实现。",
      title: "ts",
      filePath: "src/a.ts",
      fileType: "ts",
    },
  ]);
  const r = await search([kbId], "定价政策", {
    limit: 10,
    pathPattern: "src/",
    embedQueryFn: fakeEmbedQuery(null),
  });
  expect(r.results.length).toBe(1);
  expect(r.results[0].filePath).toBe("src/a.ts");
  expect(r.results[0].fileType).toBe("typescript");
});

test("过滤：file_type 同时接受 Wa-Pi 存储值与上游别名（txt → text）", async () => {
  const kbId = setupKb("类型过滤库", [
    { content: "定价政策说明。", title: "md", filePath: "docs/a.md" },
    {
      content: "定价政策 定价政策 定价政策文本。",
      title: "txt",
      filePath: "docs/b.txt",
      fileType: "txt",
    },
  ]);
  const r = await search([kbId], "定价政策", {
    limit: 10,
    fileType: "txt",
    embedQueryFn: fakeEmbedQuery(null),
  });
  expect(r.results.length).toBe(1);
  expect(r.results[0].filePath).toBe("docs/b.txt");
  expect(r.results[0].fileType).toBe("text");
});

// ============ 候选池与多样性 ============

test("多样性在截断前：limit=3 时结果必跨 2 个文件", async () => {
  const sameFile = Array.from({ length: 5 }, (_, i) => ({
    content: `定价政策第${i}条高分说明。`,
    title: `a${i}`,
    filePath: "docs/same.md",
    startLine: i * 10 + 1,
    endLine: i * 10 + 10,
  }));
  const kbId = setupKb("交错库", [
    ...sameFile,
    { content: "定价政策另一文件说明。", title: "b", filePath: "docs/other.md" },
    // 垫底块：保证 other.md 不是 BM25 最低分（最低分会被 min-max 归零后过不了分数门）
    {
      content: `定价政策附注。${"补充资料".repeat(400)}`,
      title: "pad",
      filePath: "docs/pad.md",
    },
  ]);
  const r = await search([kbId], "定价政策", {
    limit: 3,
    embedQueryFn: fakeEmbedQuery(null),
  });
  expect(r.results.length).toBe(3);
  expect(new Set(r.results.map((h) => h.filePath)).size).toBeGreaterThanOrEqual(2);
});

test("候选向量参与多样性：同向向量的块被推后（顺序会变）", async () => {
  // A：词法最强；B：词法与 C 接近，但正文与 A 完全不同（词法冗余低）且向量与 A 同向；
  // C：词法与 B 几乎相同，向量与 A 正交。无向量时 B 先于 C，有向量时 C 反超。
  const kbId = setupKb("向量多样性库", [
    { content: "定价政策甲。", title: "A", filePath: "docs/a.md", prefixContent: "定价政策 定价政策 定价政策", vec: pack(VEC_A) },
    { content: "乙乙乙乙乙。", title: "定价政策 B", filePath: "docs/b.md", prefixContent: "定价政策 定价政策", vec: pack(VEC_A) },
    { content: "丙丙丙丙丙。", title: "定价政策 C", filePath: "docs/c.md", prefixContent: "定价政策 定价政策", vec: pack(VEC_B) },
    { content: "丁丁丁丁丁。", title: "定价政策 D", filePath: "docs/d.md", prefixContent: `定价政策 ${"无关补白".repeat(200)}` },
  ]);
  const r = await search([kbId], "定价政策", {
    limit: 3,
    embedQueryFn: fakeEmbedQuery(null),
  });
  expect(r.results.length).toBe(3);
  expect(r.results[0].title).toBe("A");
  // B 与 A 向量同向（冗余 0.35），C 与 A 正交 → C 应排在 B 前面
  expect(r.results.map((h) => h.title).indexOf("定价政策 C")).toBeLessThan(
    r.results.map((h) => h.title).indexOf("定价政策 B"),
  );
});

// ============ 覆盖率文本包含 title/breadcrumb ============

test("词法证据门用 title+breadcrumb 兜底：正文只是引用该词也能过门", async () => {
  const kbId = setupKb("标题命中的库", [
    // 正文与查询零重叠；标题与面包屑精确命中（上游把 File:/Section: 计入覆盖率）
    {
      content: "完全无关的正文内容。",
      title: "定价政策",
      breadcrumb: "规范 > 定价政策",
      prefixContent: "定价政策",
      filePath: "docs/ref.md",
    },
  ]);
  const r = await search([kbId], "定价政策", { limit: 5, embedQueryFn: fakeEmbedQuery(null) });
  expect(r.results.length).toBe(1);
  expect(r.results[0].ranking.coverage).toBe(1);
});

test("词法证据门用 filePath 兜底：只有文件名命中也能过门（上游 FTS 前缀含 File: 路径）", async () => {
  const kbId = setupKb("文件名命中的库", [
    // 正文与查询零重叠、无 title/breadcrumb；文件名精确命中（FTS prefix 双写路径）
    {
      content: "完全无关的正文内容。",
      filePath: "docs/定价政策.md",
      prefixContent: "定价政策",
    },
  ]);
  const r = await search([kbId], "定价政策", { limit: 5, embedQueryFn: fakeEmbedQuery(null) });
  expect(r.found).toBe(true);
  expect(r.results[0].ranking.coverage).toBe(1);
});

// ============ 自适应扩窗 ============

test("adaptive：modeUsed=adaptive 且结果合并同文件邻块（多 source_chunk_ids）", async () => {
  const kbId = setupKb("自适应库", [
    { content: "前言说明文字。", title: "前言", filePath: "docs/a.md", startLine: 1, endLine: 10 },
    {
      content: "背景资料甲乙丙。",
      title: "背景",
      filePath: "docs/a.md",
      startLine: 190,
      endLine: 200,
    },
    { content: "定价政策说明。", title: "定价", filePath: "docs/a.md", startLine: 201, endLine: 210 },
    { content: "结尾附录。", title: "附录", filePath: "docs/a.md", startLine: 211, endLine: 220 },
  ]);
  const r = await search([kbId], "定价政策", {
    limit: 10,
    mode: "adaptive",
    embedQueryFn: fakeEmbedQuery(null),
  });
  expect(r.modeUsed).toBe("adaptive");
  expect(r.results.length).toBe(1);
  const hit = r.results[0];
  expect(hit.content).toContain("定价政策说明");
  expect(hit.content).toContain("背景资料甲乙丙"); // ±80 行内的前邻
  expect(hit.content).toContain("结尾附录"); // ±80 行内的后邻
  expect(hit.content).not.toContain("前言说明文字"); // 190 行外，不拼
  expect(hit.provenance.source_chunk_ids.length).toBeGreaterThanOrEqual(2);
  expect(hit.provenance.match_reason).toBe("adaptive");
  // 行号取扩窗后首尾
  expect(hit.startLine).toBe(190);
  expect(hit.endLine).toBe(220);
});

test("hybrid 不做扩窗：只回命中块原文", async () => {
  const kbId = setupKb("不扩窗库", [
    { content: "背景资料甲乙丙。", title: "背景", filePath: "docs/a.md", startLine: 1, endLine: 10 },
    { content: "定价政策说明。", title: "定价", filePath: "docs/a.md", startLine: 11, endLine: 20 },
  ]);
  const r = await search([kbId], "定价政策", { limit: 5, embedQueryFn: fakeEmbedQuery(null) });
  expect(r.results[0].content).toBe("定价政策说明。");
});

// ============ 多库、状态与指纹 ============

test("多库合并：两库各命中时结果含两库且带各自 kb_name，查询嵌入只算一次", async () => {
  const counter = { n: 0 };
  const kb1 = setupKb("前端规范", [{ content: "组件命名采用大驼峰写法。", title: "命名" }]);
  const kb2 = setupKb("后端规范", [{ content: "组件命名采用大驼峰规范执行。", title: "命名" }]);
  const r = await search([kb1, kb2], "组件命名", {
    limit: 5,
    embedQueryFn: fakeEmbedQuery(null, counter),
  });
  expect(r.found).toBe(true);
  const ids = new Set(r.results.map((h) => h.kbId));
  expect(ids.has(kb1)).toBe(true);
  expect(ids.has(kb2)).toBe(true);
  const byKb = new Map(r.results.map((h) => [h.kbId, h]));
  expect(byKb.get(kb1)!.kbName).toBe("前端规范");
  expect(byKb.get(kb2)!.kbName).toBe("后端规范");
  // 查询嵌入全流程只算一次（跨库复用同一查询向量/禁用态）
  expect(counter.n).toBe(1);
});

test("opts.kbId 收窄检索范围（按 id 或库名）", async () => {
  const kb1 = setupKb("甲库", [{ content: "定价政策甲说明。", title: "甲" }]);
  const kb2 = setupKb("乙库", [{ content: "定价政策乙说明。", title: "乙" }]);
  const byName = await search([kb1, kb2], "定价政策", {
    limit: 5,
    kbId: "乙库",
    embedQueryFn: fakeEmbedQuery(null),
  });
  expect(byName.results.every((h) => h.kbId === kb2)).toBe(true);
  const byId = await search([kb1, kb2], "定价政策", {
    limit: 5,
    kbId: kb1,
    embedQueryFn: fakeEmbedQuery(null),
  });
  expect(byId.results.every((h) => h.kbId === kb1)).toBe(true);
  expect(byId.skippedKbs).toEqual([]);
});

test("索引中(status=indexing)的库仍可检索旧索引，结果标 stale", async () => {
  const kbReady = setupKb("就绪库", [{ content: "定价政策说明。", title: "定价" }]);
  const kbIndexing = setupKb("索引中库", [{ content: "定价政策补充说明。", title: "定价" }]);
  // 上一轮已成功索引过（有 chunkCount + lastIndexedAt），本轮正在重建
  store.updateStatus(kbIndexing, "indexing");
  const r = await search([kbReady, kbIndexing], "定价政策", {
    limit: 5,
    embedQueryFn: fakeEmbedQuery(null),
  });
  expect(r.found).toBe(true);
  const indexingHits = r.results.filter((h) => h.kbId === kbIndexing);
  expect(indexingHits.length).toBeGreaterThan(0);
  expect(indexingHits.every((h) => h.stale === true)).toBe(true);
  expect(r.skippedKbs.some((s) => s.reason === "not_ready")).toBe(false);
});

test("索引中但从未成功索引过（chunkCount=0）的库仍被跳过", async () => {
  const kbReady = setupKb("就绪库", [{ content: "定价政策说明。", title: "定价" }]);
  const kbFresh = setupKb("首建中库", [{ content: "定价政策补充说明。", title: "定价" }]);
  store.updateStatus(kbFresh, "indexing", { fileCount: 0, chunkCount: 0, failedCount: 0 });
  const r = await search([kbReady, kbFresh], "定价政策", {
    limit: 5,
    embedQueryFn: fakeEmbedQuery(null),
  });
  expect(r.results.every((h) => h.kbId !== kbFresh)).toBe(true);
  expect(r.skippedKbs).toContainEqual({ kbId: kbFresh, reason: "not_ready" });
});

test("指纹不匹配：跳过向量通道、BM25 照常、warnings 说明向量通道已禁用", async () => {
  const kbId = setupKb("过期库", [
    // 词法可命中（若向量通道未被跳过，它还会叠加语义分）
    { content: "定价政策说明。", title: "定价", vec: pack(VEC_A) },
    // 词法零重叠 + 向量同簇：命中只能来自语义通道——不出现即证明向量通道被跳过
    { content: "苹果和香蕉的价格走势。", title: "水果", vec: pack(VEC_A) },
  ]);
  // 库登记指纹 ≠ 当前模型指纹（非 null 才算不匹配；null = 从未索引不算）
  store.updateStatus(kbId, "ready", { embedMeta: "stale-model:q8:768" });
  const r = await search([kbId], "定价政策", { limit: 5, embedQueryFn: fakeEmbedQuery(VEC_A) });
  expect(r.skippedKbs.some((s) => s.reason === "embed_meta_mismatch")).toBe(false);
  // 库仍在检索（不是被跳过），降级原因走 warnings
  expect(r.warnings?.some((w) => w.includes("过期库") && w.includes("向量通道已禁用"))).toBe(true);
  // BM25 照常
  expect(r.found).toBe(true);
  expect(r.results[0].title).toBe("定价");
  // 向量通道确实被跳过：语义专属块不在结果
  expect(r.results.some((h) => h.title === "水果")).toBe(false);
});

test("不存在的 kbId：results 为空且 skippedKbs 注明 kb_not_found", async () => {
  const kbId = setupKb("存在库", [{ content: "定价政策说明。", title: "定价" }]);
  const r = await search([kbId], "定价政策", {
    kbId: "kb_not_exist",
    limit: 5,
    embedQueryFn: fakeEmbedQuery(null),
  });
  expect(r.found).toBe(false);
  expect(r.results).toEqual([]);
  expect(r.skippedKbs).toContainEqual({ kbId: "kb_not_exist", reason: "kb_not_found" });
});

test("词法通道 AND 零命中时降级 OR 重查：长问句只部分重叠也能召回", async () => {
  const kbId = setupKb("长问句库", [
    // 块里只有「定价政策」，不含「说明」相关 bigram
    { content: "定价政策：按年订阅享九折。", title: "定价", filePath: "docs/p.md" },
  ]);
  const r = await search([kbId], "定价政策说明", { limit: 5, embedQueryFn: fakeEmbedQuery(null) });
  expect(r.found).toBe(true);
  expect(r.results.length).toBeGreaterThan(0);
  expect(r.results[0].title).toBe("定价");
});

test("融合加权：双路都命中的块融合分显著高于单路", async () => {
  const kbId = setupKb("加权融合库", [
    { content: "定价政策说明：按年订阅享九折。", title: "定价", vec: pack(VEC_A) },
    { content: "退款流程需要提交工单。", title: "退款" },
  ]);
  const r = await search([kbId], "定价政策", { limit: 5, embedQueryFn: fakeEmbedQuery(VEC_A) });
  expect(r.found).toBe(true);
  // 词法 + 语义双路命中：0.45 + 0.55 + 0.15 = 1.15（再乘库信任系数 1.04）
  expect(r.results[0].score).toBeGreaterThan(0.5);
});

test("置信门：覆盖率不足的弱命中不进结果（found=false，不许低分凑数）", async () => {
  const kbId = setupKb("弱命中库", [{ content: "定价政策", title: "定价" }]);
  // 长问句 10 个 bigram，块只覆盖 3/10 = 0.3 < 0.34 门槛
  const r = await search([kbId], "定价政策说明与退款流程", {
    limit: 5,
    embedQueryFn: fakeEmbedQuery(null),
  });
  expect(r.found).toBe(false);
  expect(r.results).toHaveLength(0);
});

test("大库：limit=5 时结果条数与内容仍正确（候选池截断不破坏结果）", async () => {
  const kbId = setupKb(
    "大库",
    Array.from({ length: 60 }, (_, i) => ({
      content: `定价政策第${i}条说明。`,
      title: `T${i}`,
      filePath: `docs/${i}.md`,
    })),
  );
  const r = await search([kbId], "定价政策", { limit: 5, embedQueryFn: fakeEmbedQuery(null) });
  expect(r.found).toBe(true);
  expect(r.results.length).toBeLessThanOrEqual(5);
  expect(r.results.length).toBeGreaterThan(0);
  expect(r.results[0].content).toContain("定价政策");
  expect(r.totalCount).toBeGreaterThan(5);
  expect(r.hasMore).toBe(true);
});

// ============ deep 重排 ============

test("mode=deep 且 reranker 未就绪：modeUsed 仍报 deep、rerankUsed=false 且仍返回结果", async () => {
  const kbId = setupKb("deep退化库", [{ content: "定价政策说明。", title: "定价" }]);
  const r = await search([kbId], "定价政策", {
    limit: 5,
    mode: "deep",
    embedQueryFn: fakeEmbedQuery(null),
    rerankFn: async () => [], // 显式注入「未就绪」，不受跨文件 reranker 全局态影响
  });
  expect(r.found).toBe(true);
  expect(r.modeUsed).toBe("deep");
  expect(r.rerankUsed).toBe(false);
});

test("mode=deep 且注入 scorer：采用重排器返回顺序（分降序），rerankUsed=true", async () => {
  const kbId = setupKb("deep库", [
    { content: "定价政策说明。", title: "定价" },
    { content: "定价政策附录。", title: "附录" },
  ]);
  const r = await search([kbId], "定价政策", {
    limit: 5,
    mode: "deep",
    embedQueryFn: fakeEmbedQuery(null),
    // 反转顺序：让原本第二的排到第一（重排器契约：返回即分降序）
    rerankFn: async (_q, candidates) =>
      candidates
        .map((candidate, i) => ({ chunkId: candidate.chunkId, score: i === 0 ? 0 : 1 }))
        .sort((a, b) => b.score - a.score),
  });
  expect(r.modeUsed).toBe("deep");
  expect(r.rerankUsed).toBe(true);
  expect(r.results[0].title).toBe("附录");
  expect(r.results[0].provenance.match_reason).toBe("rerank");
});

test("deep：重排结果按 topK 截断（max(limit × multiplier, limit)）", async () => {
  const kbId = setupKb(
    "deep截断库",
    Array.from({ length: 40 }, (_, i) => ({
      content: `定价政策第${i}条说明。`,
      title: `T${i}`,
      filePath: `docs/${i}.md`,
    })),
  );
  const r = await search([kbId], "定价政策", {
    limit: 5,
    mode: "deep",
    embedQueryFn: fakeEmbedQuery(null),
    // 分数倒序注入，故意不守 topK：验证调用方仍会截断
    rerankFn: async (_q, candidates) =>
      candidates.map((candidate, i) => ({ chunkId: candidate.chunkId, score: candidates.length - i })),
  });
  expect(r.rerankUsed).toBe(true);
  // balanced 的 deep_rerank_top_k_multiplier=3 → 5×3=15；不截断会是 30
  expect(r.totalCount).toBeLessThanOrEqual(15);
  expect(r.totalCount).toBe(15);
});

// ============ auto 模式 ============

test("auto：带引号的精确查询走 fast 并命中", async () => {
  const kbId = setupKb("自动库", [{ content: "定价政策说明。", title: "定价" }]);
  const r = await search([kbId], '"定价政策"', { limit: 5, mode: "auto", embedQueryFn: fakeEmbedQuery(null) });
  expect(r.modeUsed).toBe("fast");
  expect(r.found).toBe(true);
  expect(r.retryModes).toEqual([]);
});

test("auto：fast 弱结果（严格短语零命中）回退 hybrid 拿到结果", async () => {
  const kbId = setupKb("自动回退库", [{ content: "定价政策说明。", title: "定价" }]);
  // 带引号 → 主模式 fast；引号内容不在库里 → fast 零命中 → 回退 hybrid；
  // hybrid 覆盖率 3/4=0.75 ≥ 0.67，不再判弱
  const r = await search([kbId], '"蒸饺" 定价政策', {
    limit: 5,
    mode: "auto",
    embedQueryFn: fakeEmbedQuery(null),
  });
  expect(r.found).toBe(true);
  expect(r.modeUsed).toBe("hybrid");
  expect(r.retryModes).toEqual(["fast"]);
});

test("auto：概念型查询走 semantic；结果有词法重叠时不触发回退", async () => {
  const kbId = setupKb("语义库", [
    { content: "苹果和香蕉的价格走势分析。", title: "水果", vec: pack(VEC_A) },
  ]);
  // 含「如何」→ semantic；语料与查询有词法重叠（价格/走势/分析）→ 不回退
  const r = await search([kbId], "水果价格走势如何分析", {
    limit: 5,
    mode: "auto",
    embedQueryFn: fakeEmbedQuery(VEC_A),
  });
  expect(r.modeUsed).toBe("semantic");
  expect(r.found).toBe(true);
  expect(r.retryModes).toEqual([]);
});

test("auto：三次尝试全弱 → 返回空结果并保留尝试链", async () => {
  const kbId = setupKb("自动全弱库", [{ content: "定价政策说明。", title: "定价" }]);
  // 带引号 → 主模式 fast；严格短语零命中 → 弱；hybrid 只部分覆盖（1/3 < 0.67）且无精确串
  // → 弱；第三次 semantic 因模型不可用（null）零结果 → 弱，达到 3 次上限即返回空。
  const r = await search([kbId], '"无关词" 定价', {
    limit: 5,
    mode: "auto",
    embedQueryFn: fakeEmbedQuery(null),
  });
  expect(r.found).toBe(false);
  expect(r.results).toEqual([]);
  expect(r.modeUsed).toBe("semantic");
  expect(r.retryModes).toEqual(["fast", "hybrid"]);
  expect(r.totalCount).toBe(0);
  expect(r.hasMore).toBe(false);
});

test("auto：semantic 主模式有向量命中即返回（上游不对 semantic 主模式做覆盖率回退）", async () => {
  const kbId = setupKb("语义主模式库", [
    { content: "苹果和香蕉的价格走势分析。", title: "水果", vec: pack(VEC_A) },
  ]);
  // 含「如何」→ semantic；纯语义命中但覆盖率 0：isWeakAutoResponse 只看「回退到 semantic」的场景
  const r = await search([kbId], "如何防止会话劫持", {
    limit: 5,
    mode: "auto",
    embedQueryFn: fakeEmbedQuery(VEC_A),
  });
  expect(r.modeUsed).toBe("semantic");
  expect(r.found).toBe(true);
  expect(r.retryModes).toEqual([]);
});

// ============ 新鲜度（provenance.stale）============

test("索引失败的库只要有旧索引仍可检索，结果标注 stale（不再整库下线）", async () => {
  const kbId = setupKb("失败但有旧索引", [{ content: "定价政策说明。", title: "定价" }]);
  // 更新失败：status=error，但 counters 与 lastIndexedAt 保留（旧索引数据还在库里）
  store.updateStatus(kbId, "ready", { fileCount: 1, chunkCount: 1, lastIndexedAt: Date.now() });
  store.updateStatus(kbId, "error");
  const r = await search([kbId], "定价政策", { limit: 5, embedQueryFn: fakeEmbedQuery(null) });
  expect(r.found).toBe(true);
  expect(r.results[0].title).toBe("定价");
  expect(r.results[0].stale).toBe(true);
  expect(r.results[0].provenance.stale).toBe(true);
  // 不再作为 not_ready 跳过
  expect(r.skippedKbs.some((s) => s.reason === "not_ready")).toBe(false);
});

test("命中块的源文件 mtime 与索引记录不一致时标 stale", async () => {
  // 源文件在索引之后被改过（这里 insertChunk 记录的 file_mtime=1，磁盘文件必然更新）
  const kbId = setupKb("过期块库", [{ content: "定价政策说明。", title: "定价", filePath: "docs/p.md" }]);
  mkdirSync(join(waPiDir, "docs"), { recursive: true });
  writeFileSync(join(waPiDir, "docs/p.md"), "新版内容");
  const r = await search([kbId], "定价政策", { limit: 5, embedQueryFn: fakeEmbedQuery(null) });
  expect(r.results[0].stale).toBe(true);
  expect(r.results[0].provenance.stale).toBe(true);
});

test("源文件不在磁盘上（抽取失败/外删未重索引）同样标 stale", async () => {
  const kbId = setupKb("缺文件库", [{ content: "定价政策说明。", title: "定价", filePath: "docs/gone.md" }]);
  const r = await search([kbId], "定价政策", { limit: 5, embedQueryFn: fakeEmbedQuery(null) });
  expect(r.found).toBe(true);
  expect(r.results[0].stale).toBe(true);
});

test("源文件 mtime 与索引记录一致时不标 stale", async () => {
  mkdirSync(join(waPiDir, "docs"), { recursive: true });
  const abs = join(waPiDir, "docs/p.md");
  writeFileSync(abs, "定价政策说明。");
  const kbId = setupKb("新鲜库", [
    { content: "定价政策说明。", title: "定价", filePath: "docs/p.md", fileMtime: statSync(abs).mtimeMs },
  ]);
  const r = await search([kbId], "定价政策", { limit: 5, embedQueryFn: fakeEmbedQuery(null) });
  expect(r.found).toBe(true);
  expect(r.results[0].stale).toBeUndefined();
  expect(r.results[0].provenance.stale).toBe(false);
});

test("mtime 只差亚毫秒也算陈旧：严格相等比对，无容差", async () => {
  const kbId = setupKb("亚毫秒库", [
    { content: "定价政策说明。", title: "定价", filePath: "docs/p.md", fileMtime: 1000 },
  ]);
  // 注入 stat：磁盘上的 mtime 与记录差 0.5ms（SQLite 对分数值存 REAL，往返严格相等，
  // 这种差异只可能是文件真的动过 → 不该被容差吞掉）
  const statFn = async () => ({ mtimeMs: 1000.5 });
  const r = await search([kbId], "定价政策", {
    limit: 5,
    embedQueryFn: fakeEmbedQuery(null),
    statFn,
  });
  expect(r.results[0].stale).toBe(true);
});

test("file_path 越出库根（绝对路径/..）直接判 stale 且不 stat", async () => {
  const kbId = setupKb("越界库", [
    { content: "定价政策说明。", title: "定价", filePath: "../../etc/passwd" },
  ]);
  const calls: string[] = [];
  const statFn = async (p: string) => {
    calls.push(p);
    return { mtimeMs: 1 };
  };
  const r = await search([kbId], "定价政策", {
    limit: 5,
    embedQueryFn: fakeEmbedQuery(null),
    statFn,
  });
  expect(r.results[0].stale).toBe(true);
  expect(calls).toEqual([]);
});

test("新鲜度核对只做在截断后的 ≤limit 条上（不放大 IO）", async () => {
  const kbId = setupKb("多块库", [
    { content: "定价政策甲说明。", title: "甲", filePath: "docs/a.md" },
    { content: "定价政策乙说明。", title: "乙", filePath: "docs/b.md" },
    { content: "定价政策丙说明。", title: "丙", filePath: "docs/c.md" },
  ]);
  let calls = 0;
  const statFn = async () => {
    calls++;
    return { mtimeMs: 1 };
  };
  const r = await search([kbId], "定价政策", {
    limit: 2,
    embedQueryFn: fakeEmbedQuery(null),
    statFn,
  });
  expect(r.results.length).toBe(2);
  expect(calls).toBe(2);
});

test("整库 error 的陈旧命中已标 stale 后不再 stat", async () => {
  const kbId = setupKb("整库陈旧", [{ content: "定价政策说明。", title: "定价" }]);
  store.updateStatus(kbId, "ready", { fileCount: 1, chunkCount: 1, lastIndexedAt: Date.now() });
  store.updateStatus(kbId, "error");
  let calls = 0;
  const statFn = async () => {
    calls++;
    return { mtimeMs: 1 };
  };
  const r = await search([kbId], "定价政策", {
    limit: 5,
    embedQueryFn: fakeEmbedQuery(null),
    statFn,
  });
  expect(r.results[0].stale).toBe(true);
  expect(calls).toBe(0);
});

test("error 且从未成功索引过的库仍被跳过（无可用旧索引）", async () => {
  const kbId = setupKb("首建失败", [{ content: "定价政策说明。", title: "定价" }]);
  store.updateStatus(kbId, "error", { fileCount: 0, chunkCount: 0, failedCount: 0 });
  const r = await search([kbId], "定价政策", { limit: 5, embedQueryFn: fakeEmbedQuery(null) });
  expect(r.found).toBe(false);
  expect(r.skippedKbs).toContainEqual({ kbId, reason: "not_ready" });
});

// ============ auto 补齐（对齐上游 suggestions / skippedKbs 语义）============

test("非 auto 空结果给出上游 suggestions 两条（fast/semantic 提示 + 检查库状态）", async () => {
  const kbId = setupKb("提示库", [{ content: "苹果香蕉价格分析。", vec: pack(VEC_B) }]);
  const r = await searchKnowledge(ctx, [kbId], "量子通信技术", { limit: 5, embedQueryFn: fakeEmbedQuery(VEC_A) });
  expect(r.results).toEqual([]);
  expect(r.suggestions?.length).toBe(2);
  expect(r.suggestions?.join(" ")).toContain("mode 'fast'");
  expect(r.suggestions?.join(" ")).toContain("knowledge_status");
});

test("有结果时不给 suggestions（与上游一致：undefined）", async () => {
  const kbId = setupKb("有结果库", [{ content: "定价政策说明。" }]);
  const r = await searchKnowledge(ctx, [kbId], "定价政策", { limit: 5, embedQueryFn: fakeEmbedQuery(null) });
  expect(r.results.length).toBeGreaterThan(0);
  expect(r.suggestions).toBeUndefined();
});

test("auto 全弱：返回上游 auto 建议文案，并保留诊断（modeUsed/retryModes/tuning）", async () => {
  const kbId = setupKb("全弱库", [{ content: "苹果香蕉价格分析。", vec: pack(VEC_A) }]);
  // hybrid 词法锚定跳过 → fast 无命中 → semantic 命中但 coverage=0 判弱
  const r = await searchKnowledge(ctx, [kbId], "量子通信技术", { limit: 5, mode: "auto", embedQueryFn: fakeEmbedQuery(VEC_A) });
  expect(r.results).toEqual([]);
  expect(r.suggestions?.length).toBe(1);
  expect(r.suggestions?.[0]).toContain("auto mode fallback");
  expect(r.retryModes?.length).toBe(2);
  expect(r.modeUsed).toBe("semantic");
  expect(r.tuning).toBeTruthy();
});

test("auto 成功：suggestions 透传该次尝试的（有结果 → undefined），skippedKbs 不残留早期尝试的跳过原因", async () => {
  const hitKb = setupKb("命中库", [{ content: "定价政策说明。" }]);
  const missKb = setupKb("无词法库", [{ content: "苹果香蕉价格分析。" }]);
  const r = await searchKnowledge(ctx, [hitKb, missKb], "定价政策", { limit: 5, mode: "auto", embedQueryFn: fakeEmbedQuery(null) });
  expect(r.results.length).toBeGreaterThan(0);
  expect(r.modeUsed).toBe("hybrid");
  expect(r.suggestions).toBeUndefined();
});

test("A：检索结果带库根绝对路径（模型可拼出可读路径，不必再 find）", async () => {
  const kbId = setupKb("路径库", [{ content: "定价政策说明。", filePath: "docs/pricing.md" }]);
  const r = await searchKnowledge(ctx, [kbId], "定价政策", { limit: 5, embedQueryFn: fakeEmbedQuery(null) });
  expect(r.results[0].kbFolderPath).toBe(waPiDir);
  expect(r.results[0].filePath).toBe("docs/pricing.md");
});
