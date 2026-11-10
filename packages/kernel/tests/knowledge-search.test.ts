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
  expect(r.results.length).toBeGreaterThanOrEqual(2);
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

test("向量通道：语义相近（手工向量夹角小）命中", async () => {
  const kbId = setupKb("研究笔记", [
    // 两块语料与查询词零重叠：命中只能来自语义通道
    { content: "苹果和香蕉的价格走势分析。", title: "水果", vec: pack(VEC_A) },
    { content: "桌子和椅子的木料工艺记录。", title: "木工", vec: pack(VEC_B) },
  ]);
  // 查询向量取簇 A（即 VEC_A 方向）；「量子通信技术」与语料零词法重叠
  const r = await searchKnowledge(ctx, [kbId], "量子通信技术", 5, fakeEmbedQuery(VEC_A));
  expect(r.found).toBe(true);
  expect(r.results.length).toBeGreaterThan(0);
  expect(r.results[0].title).toBe("水果");
  // 簇 B 与查询向量正交（距离≈1 > 0.75 门）：被距离门拦住，不许低分凑数
  expect(r.results.some((h) => h.title === "木工")).toBe(false);
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
