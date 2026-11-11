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
import { searchKnowledge } from "../src/knowledge/search";
import type { KbContext } from "../src/knowledge/index";
import { bigram } from "../src/memory/bigram";
import { EMBED_DIM } from "../src/memory/schema";

// 知识库混合检索测试：fake 向量手工插块建库（不经模型、不经 indexer）。
// 向量用正交单位向量造两簇：簇 A（e0）/ 簇 B（e1），量化距离 = 1 − 余弦，
// 同簇 ≈0（过 0.75 门），跨簇 ≈1（被门拦）。查询向量经第 5 参注入（同 indexer
// 的 EmbedFn 注入模式），避免 mock.module 泄漏；null 即「模型不可用 → 语义禁用」。

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
  prefixContent?: string;
  title?: string | null;
  breadcrumb?: string | null;
  filePath?: string;
  startLine?: number | null;
  endLine?: number | null;
  vec?: Uint8Array;
  /** 索引时记录的源文件 mtime（缺省 1：与磁盘上任何真实文件都对不上） */
  fileMtime?: number;
}

/** 手工插块：chunks 行 + FTS 双写（body = bigram(prefixContent)，与 indexer 写入格式一致） */
function insertChunk(db: Database, c: FakeChunk): void {
  const id = randomUUID();
  const prefixContent = c.prefixContent ?? c.content;
  db.run(
    `INSERT INTO chunks (id, file_path, file_type, title, breadcrumb, start_line, end_line,
       content, prefix_content, content_hash, file_mtime, file_size, embedding, updated_at)
     VALUES (?, ?, 'md', ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    [
      id,
      c.filePath ?? "docs/doc.md",
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
  store.updateStatus(kbId, "ready");
  return kbId;
}

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
  const r = await searchKnowledge(ctx, [kbId], "定价政策", 5, fakeEmbedQuery(null));
  expect(r.found).toBe(true);
  expect(r.results.length).toBeGreaterThan(0);
  expect(r.results[0].title).toBe("定价");
});

test("结果带出处：file_path/title/lines/kb_name 且 score 有序", async () => {
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
  const r = await searchKnowledge(ctx, [kbId], "定价政策", 5, fakeEmbedQuery(null));
  // min-max 归一（对齐 pi-knowledge 的 fusion）的必然结果：只有一个通道有候选时，除最高分
  // 外全部归 0，过不了 0.18 置信门——所以纯词法场景（模型不可用）每库只留最相关一条。
  // 改用相对强度归一时这里能留两条；本用例只断言上游语义下的实际输出，
  // 「同库多文件出处」由多样性/窗口用例覆盖。
  expect(r.results.length).toBe(1);
  for (const h of r.results) {
    expect(typeof h.kbId).toBe("string");
    expect(h.kbName).toBe("产品手册");
    expect(typeof h.content).toBe("string");
    expect(typeof h.filePath).toBe("string");
    expect(typeof h.score).toBe("number");
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
  // score 非升序
  for (let i = 1; i < r.results.length; i++) {
    expect(r.results[i - 1].score).toBeGreaterThanOrEqual(r.results[i].score);
  }
});

test("语义通道（对齐 pi-knowledge）：hybrid 有词法锚定 → 纯语义命中被整库跳过", async () => {
  const kbId = setupKb("研究笔记", [
    // 两块语料与查询词零重叠：命中只能来自语义通道
    { content: "苹果和香蕉的价格走势分析。", title: "水果", vec: pack(VEC_A) },
    { content: "桌子和椅子的木料工艺记录。", title: "木工", vec: pack(VEC_B) },
  ]);
  // 「量子通信技术」与语料零词法重叠 → hybrid 的词法锚定把整库跳过
  const r = await searchKnowledge(ctx, [kbId], "量子通信技术", 5, fakeEmbedQuery(VEC_A));
  expect(r.found).toBe(false);
  expect(r.skippedKbs.some((k) => k.reason === "lexical_anchor")).toBe(true);
});

test("semantic 模式：纯向量命中（无词法锚定、无置信门）", async () => {
  const kbId = setupKb("研究笔记", [
    { content: "苹果和香蕉的价格走势分析。", title: "水果", vec: pack(VEC_A) },
    { content: "桌子和椅子的木料工艺记录。", title: "木工", vec: pack(VEC_B) },
  ]);
  const r = await searchKnowledge(ctx, [kbId], "量子通信技术", 5, fakeEmbedQuery(VEC_A), {
    mode: "semantic",
  });
  expect(r.found).toBe(true);
  expect(r.mode).toBe("semantic");
  expect(r.results[0].title).toBe("水果");
  // 簇 B 与查询向量正交（距离≈1 > 0.75 门）：被距离门拦住，不许低分凑数
  expect(r.results.some((h) => h.title === "木工")).toBe(false);
});

test("semantic_hybrid 模式：去掉词法锚定与词法证据门，纯语义命中也能进结果", async () => {
  const kbId = setupKb("研究笔记", [
    { content: "苹果和香蕉的价格走势分析。", title: "水果", vec: pack(VEC_A) },
  ]);
  const r = await searchKnowledge(ctx, [kbId], "量子通信技术", 5, fakeEmbedQuery(VEC_A), {
    mode: "semantic_hybrid",
  });
  expect(r.found).toBe(true);
  expect(r.mode).toBe("semantic_hybrid");
  expect(r.results[0].title).toBe("水果");
});

test("全部库零命中返回 found:false 而非低分凑数", async () => {
  const kbId = setupKb("产品手册", [
    { content: "定价政策说明。", title: "定价", vec: pack(VEC_A) },
  ]);
  // 词法零重叠 + 语义向量正交（距离≈1 > 0.75 门被拦）
  const r = await searchKnowledge(ctx, [kbId], "完全不相关的量子术语", 5, fakeEmbedQuery(VEC_B));
  expect(r.found).toBe(false);
  expect(r.results).toEqual([]);
});

test("多库合并：两库各命中时结果含两库且带各自 kb_name", async () => {
  const counter = { n: 0 };
  const kb1 = setupKb("前端规范", [{ content: "组件命名采用大驼峰写法。", title: "命名" }]);
  const kb2 = setupKb("后端规范", [{ content: "组件命名采用大驼峰规范执行。", title: "命名" }]);
  const r = await searchKnowledge(ctx, [kb1, kb2], "组件命名", 5, fakeEmbedQuery(null, counter));
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

test("索引中(status=indexing)的库被跳过并在 skippedKbs 说明", async () => {
  const kbReady = setupKb("就绪库", [{ content: "定价政策说明。", title: "定价" }]);
  const kbIndexing = setupKb("索引中库", [{ content: "定价政策补充说明。", title: "定价" }]);
  store.updateStatus(kbIndexing, "indexing");
  const r = await searchKnowledge(ctx, [kbReady, kbIndexing], "定价政策", 5, fakeEmbedQuery(null));
  expect(r.found).toBe(true);
  expect(r.results.every((h) => h.kbId !== kbIndexing)).toBe(true);
  expect(r.results.some((h) => h.kbId === kbReady)).toBe(true);
  expect(r.skippedKbs).toContainEqual({ kbId: kbIndexing, reason: "not_ready" });
});

test("指纹不匹配：跳过向量通道、BM25 照常、skippedKbs 注明 embed_meta_mismatch", async () => {
  const kbId = setupKb("过期库", [
    // 词法可命中（若向量通道未被跳过，它还会叠加语义分）
    { content: "定价政策说明。", title: "定价", vec: pack(VEC_A) },
    // 词法零重叠 + 向量同簇：命中只能来自语义通道——不出现即证明向量通道被跳过
    { content: "苹果和香蕉的价格走势。", title: "水果", vec: pack(VEC_A) },
  ]);
  // 库登记指纹 ≠ 当前模型指纹（非 null 才算不匹配；null = 从未索引不算）
  store.updateStatus(kbId, "ready", { embedMeta: "stale-model:q8:768" });
  const r = await searchKnowledge(ctx, [kbId], "定价政策", 5, fakeEmbedQuery(VEC_A));
  expect(r.skippedKbs).toContainEqual({ kbId, reason: "embed_meta_mismatch" });
  // BM25 照常
  expect(r.found).toBe(true);
  expect(r.results[0].title).toBe("定价");
  // 向量通道确实被跳过：语义专属块不在结果
  expect(r.results.some((h) => h.title === "水果")).toBe(false);
});

test("词法通道 AND 零命中时降级 OR 重查：长问句只部分重叠也能召回", async () => {
  const kbId = setupKb("长问句库", [
    // 块里只有「定价政策」，不含「说明」相关 bigram
    { content: "定价政策：按年订阅享九折。", title: "定价", filePath: "docs/p.md" },
  ]);
  // 查询「定价政策说明」的四字 / 三字组合与块部分重叠：
  // AND 语义下需要同时出现「政说」「说明」等 bigram → 零命中；OR 回退应召回
  const r = await searchKnowledge(ctx, [kbId], "定价政策说明", 5, fakeEmbedQuery(null));
  expect(r.found).toBe(true);
  expect(r.results.length).toBeGreaterThan(0);
  expect(r.results[0].title).toBe("定价");
});

test("索引失败的库只要有旧索引仍可检索，结果标注 stale（不再整库下线）", async () => {
  const kbId = setupKb("失败但有旧索引", [{ content: "定价政策说明。", title: "定价" }]);
  // 更新失败：status=error，但 counters 与 lastIndexedAt 保留（旧索引数据还在库里）
  store.updateStatus(kbId, "ready", { fileCount: 1, chunkCount: 1, lastIndexedAt: Date.now() });
  store.updateStatus(kbId, "error");
  const r = await searchKnowledge(ctx, [kbId], "定价政策", 5, fakeEmbedQuery(null));
  expect(r.found).toBe(true);
  expect(r.results[0].title).toBe("定价");
  expect(r.results[0].stale).toBe(true);
  // 不再作为 not_ready 跳过
  expect(r.skippedKbs.some((s) => s.reason === "not_ready")).toBe(false);
});

test("命中块的源文件 mtime 与索引记录不一致时标 stale", async () => {
  // 源文件在索引之后被改过（这里 insertChunk 记录的 file_mtime=1，磁盘文件必然更新）
  const kbId = setupKb("过期块库", [{ content: "定价政策说明。", title: "定价", filePath: "docs/p.md" }]);
  mkdirSync(join(waPiDir, "docs"), { recursive: true });
  writeFileSync(join(waPiDir, "docs/p.md"), "新版内容");
  const r = await searchKnowledge(ctx, [kbId], "定价政策", 5, fakeEmbedQuery(null));
  expect(r.results[0].stale).toBe(true);
});

test("源文件不在磁盘上（抽取失败/外删未重索引）同样标 stale", async () => {
  const kbId = setupKb("缺文件库", [{ content: "定价政策说明。", title: "定价", filePath: "docs/gone.md" }]);
  const r = await searchKnowledge(ctx, [kbId], "定价政策", 5, fakeEmbedQuery(null));
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
  const r = await searchKnowledge(ctx, [kbId], "定价政策", 5, fakeEmbedQuery(null));
  expect(r.found).toBe(true);
  expect(r.results[0].stale).toBeUndefined();
});

test("mtime 只差亚毫秒也算陈旧：严格相等比对，无容差", async () => {
  const kbId = setupKb("亚毫秒库", [
    { content: "定价政策说明。", title: "定价", filePath: "docs/p.md", fileMtime: 1000 },
  ]);
  // 注入 stat：磁盘上的 mtime 与记录差 0.5ms（SQLite 对分数值存 REAL，往返严格相等，
  // 这种差异只可能是文件真的动过 → 不该被容差吞掉）
  const statFn = async () => ({ mtimeMs: 1000.5 });
  const r = await searchKnowledge(ctx, [kbId], "定价政策", 5, fakeEmbedQuery(null), { statFn });
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
  const r = await searchKnowledge(ctx, [kbId], "定价政策", 5, fakeEmbedQuery(null), { statFn });
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
  const r = await searchKnowledge(ctx, [kbId], "定价政策", 2, fakeEmbedQuery(null), { statFn });
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
  const r = await searchKnowledge(ctx, [kbId], "定价政策", 5, fakeEmbedQuery(null), { statFn });
  expect(r.results[0].stale).toBe(true);
  expect(calls).toBe(0);
});

test("error 且从未成功索引过的库仍被跳过（无可用旧索引）", async () => {
  const kbId = setupKb("首建失败", [{ content: "定价政策说明。", title: "定价" }]);
  store.updateStatus(kbId, "error", { fileCount: 0, chunkCount: 0, failedCount: 0 });
  const r = await searchKnowledge(ctx, [kbId], "定价政策", 5, fakeEmbedQuery(null));
  expect(r.found).toBe(false);
  expect(r.skippedKbs).toContainEqual({ kbId, reason: "not_ready" });
});

test("融合改加权分数：双路都命中的块融合分显著高于 RRF 量纲（RRF 上限≈0.033）", async () => {
  const kbId = setupKb("加权融合库", [
    { content: "定价政策说明：按年订阅享九折。", title: "定价", vec: pack(VEC_A) },
    { content: "退款流程需要提交工单。", title: "退款" },
  ]);
  const r = await searchKnowledge(ctx, [kbId], "定价政策", 5, fakeEmbedQuery(VEC_A));
  expect(r.found).toBe(true);
  // 词法 + 语义双路命中：0.45 + 0.55 + 0.15 = 1.15（RRF 下最多 2/61≈0.033）
  expect(r.results[0].score).toBeGreaterThan(0.5);
});

test("置信门：覆盖率不足的弱命中不进结果（found=false，不许低分凑数）", async () => {
  const kbId = setupKb("弱命中库", [{ content: "定价政策", title: "定价" }]);
  // 长问句 10 个 bigram，块只覆盖 3/10 = 0.3 < 0.34 门槛
  const r = await searchKnowledge(ctx, [kbId], "定价政策说明与退款流程", 5, fakeEmbedQuery(null));
  expect(r.found).toBe(false);
  expect(r.results).toHaveLength(0);
});

test("自适应扩窗：命中块合并同文件相邻块并互相补上下文", async () => {
  const kbId = setupKb("扩窗库", [
    { content: "第一段：概述。", title: "A", filePath: "docs/w.md", startLine: 1, endLine: 5 },
    { content: "第二段：定价政策说明。", title: "B", filePath: "docs/w.md", startLine: 6, endLine: 10 },
    { content: "第三段：附录。", title: "C", filePath: "docs/w.md", startLine: 11, endLine: 15 },
  ]);
  const r = await searchKnowledge(ctx, [kbId], "定价政策", 5, fakeEmbedQuery(null));
  expect(r.found).toBe(true);
  // 命中中间的「第二段」，扩窗后正文应带上前后邻块
  expect(r.results[0].content).toContain("定价政策说明");
  expect(r.results[0].content).toContain("第一段");
  expect(r.results[0].content).toContain("第三段");
});

test("候选回读收敛：大库 limit=5 时结果条数与内容仍正确（截断不破坏结果）", async () => {
  const kbId = setupKb(
    "大库",
    Array.from({ length: 60 }, (_, i) => ({
      content: `定价政策第${i}条说明。`,
      title: `T${i}`,
      filePath: `docs/${i}.md`,
    })),
  );
  const r = await searchKnowledge(ctx, [kbId], "定价政策", 5, fakeEmbedQuery(null), { readLimitMultiplier: 2 });
  expect(r.found).toBe(true);
  expect(r.results.length).toBeLessThanOrEqual(5);
  expect(r.results[0].content).toContain("定价政策");
});

test("mode=deep 且 reranker 未就绪：退化为 hybrid，mode=hybrid、rerankUsed=false 且仍返回结果", async () => {
  const kbId = setupKb("deep退化库", [{ content: "定价政策说明。", title: "定价" }]);
  const r = await searchKnowledge(ctx, [kbId], "定价政策", 5, fakeEmbedQuery(null), { mode: "deep" });
  expect(r.found).toBe(true);
  expect(r.mode).toBe("hybrid");
  expect(r.rerankUsed).toBe(false);
});

test("mode=deep 且注入 scorer：按重排分排序，mode=deep、rerankUsed=true", async () => {
  const kbId = setupKb("deep库", [
    { content: "定价政策说明。", title: "定价" },
    { content: "定价政策附录。", title: "附录" },
  ]);
  const r = await searchKnowledge(ctx, [kbId], "定价政策", 5, fakeEmbedQuery(null), {
    mode: "deep",
    // 反转顺序：让原本第二的排到第一
    rerankFn: async (_q, docs) => docs.map((_, i) => (i === 0 ? 0 : 1)),
  });
  expect(r.mode).toBe("deep");
  expect(r.rerankUsed).toBe(true);
  expect(r.results[0].title).toBe("附录");
});

// ============ 七种模式（对齐 pi-knowledge）的端到端行为 ============

test("fast：严格短语 + 关 OR 回退；只有部分词重叠时零命中（hybrid 会 OR 兜底命中）", async () => {
  const kbId = setupKb("严格库", [{ content: "定价政策说明。", title: "定价" }]);
  const fast = await searchKnowledge(ctx, [kbId], "定价 报销", 5, fakeEmbedQuery(null), {
    mode: "fast",
  });
  const hy = await searchKnowledge(ctx, [kbId], "定价 报销", 5, fakeEmbedQuery(null), {
    mode: "hybrid",
  });
  expect(fast.mode).toBe("fast");
  expect(fast.found).toBe(false); // 严格 AND，两词都要在
  expect(hy.found).toBe(true); // OR 兜底，「定价」命中即召回
});

test("fast：命中时不扩窗（只给命中块原文）", async () => {
  const kbId = setupKb("快查库", [
    { content: "定价政策说明。", title: "定价", filePath: "docs/a.md", startLine: 1, endLine: 10 },
    { content: "退款流程说明。", title: "退款", filePath: "docs/a.md", startLine: 11, endLine: 20 },
  ]);
  const r = await searchKnowledge(ctx, [kbId], "定价政策", 5, fakeEmbedQuery(null), {
    mode: "fast",
  });
  expect(r.results[0].content).toBe("定价政策说明。");
});

test("adaptive：只在 ±80 行内扩窗；块级扩窗会拼的远邻居不进来", async () => {
  const kbId = setupKb("自适应库", [
    { content: "前言说明文字。", title: "前言", filePath: "docs/a.md", startLine: 1, endLine: 10 },
    { content: "定价政策说明。", title: "定价", filePath: "docs/a.md", startLine: 200, endLine: 210 },
    { content: "附录补充文字。", title: "附录", filePath: "docs/a.md", startLine: 400, endLine: 410 },
  ]);
  const hy = await searchKnowledge(ctx, [kbId], "定价政策", 5, fakeEmbedQuery(null), {
    mode: "hybrid",
  });
  const ad = await searchKnowledge(ctx, [kbId], "定价政策", 5, fakeEmbedQuery(null), {
    mode: "adaptive",
  });
  expect(hy.results[0].content).toContain("前言说明文字。"); // 块级扩窗：前后邻块都拼
  expect(ad.results[0].content).not.toContain("前言说明文字。"); // 行窗：190 行外，不拼
  expect(ad.results[0].content).toContain("定价政策说明。");
  expect(ad.mode).toBe("adaptive");
});

test("auto：带引号的精确查询走 fast 并命中", async () => {
  const kbId = setupKb("自动库", [{ content: "定价政策说明。", title: "定价" }]);
  const r = await searchKnowledge(ctx, [kbId], '"定价政策"', 5, fakeEmbedQuery(null), {
    mode: "auto",
  });
  expect(r.mode).toBe("fast");
  expect(r.found).toBe(true);
});

test("auto：fast 弱结果（严格短语零命中）回退 hybrid 拿到结果", async () => {
  const kbId = setupKb("自动回退库", [{ content: "定价政策说明。", title: "定价" }]);
  // 带引号 → 主模式 fast；引号内容不在库里 → fast 零命中 → 回退 hybrid，
  // OR 兜底命中「定价」，且信号词少（≤3）时词法证据门放行
  const r = await searchKnowledge(ctx, [kbId], '"蒸饺" 定价', 5, fakeEmbedQuery(null), {
    mode: "auto",
  });
  expect(r.found).toBe(true);
  expect(r.mode).toBe("hybrid");
});

test("auto：概念型长问题走 semantic；结果有词法重叠时不触发回退", async () => {
  const kbId = setupKb("语义库", [
    { content: "苹果和香蕉的价格走势分析。", title: "水果", vec: pack(VEC_A) },
  ]);
  // 含「怎么」→ semantic；语料与查询有词法重叠（价格/走势/分析），coverage>0 → 不回退
  const r = await searchKnowledge(ctx, [kbId], "水果的价格走势是怎么分析的", 5, fakeEmbedQuery(VEC_A), {
    mode: "auto",
  });
  expect(r.mode).toBe("semantic");
  expect(r.found).toBe(true);
});

test("auto：semantic 结果零词法重叠（弱）→ 按回退链换模式", async () => {
  const kbId = setupKb("语义弱库", [
    { content: "苹果和香蕉的价格走势分析。", title: "水果", vec: pack(VEC_A) },
  ]);
  // 含「怎么」→ semantic；纯语义命中但 coverage=0 → 判弱 → 回退（hybrid 词法锚定跳过、adaptive 兜底）
  const r = await searchKnowledge(ctx, [kbId], "登录是怎么防止会话劫持的", 5, fakeEmbedQuery(VEC_A), {
    mode: "auto",
  });
  expect(r.mode).not.toBe("semantic");
});
