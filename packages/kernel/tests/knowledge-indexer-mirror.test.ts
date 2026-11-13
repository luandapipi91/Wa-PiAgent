// 索引器镜像接入测试（任务 8，规格 §5.3/§6.8/§6.9）：
//   1. 新文件：转换落盘 mirror + 块 file_path=源相对路径 + FTS 可检索 altChunk 正文（质量提升锁）；
//   2. 自愈：快筛命中（源未变）且副本被外部改写 → 下一轮以副本为准重切；
//   3. 降级：转换失败回退 extractText，无副本、块存在、failed 清单含该文件、检索不抛错；
//   4. 删除：源文件删除 → 副本与块一并清理；
//   5. mirror_meta 统计落库（converterVersion/converted/degraded/images）。
// 夹具模式与 knowledge-watcher.test.ts 一致：临时源目录 + fake embed + 每库 db 断言即开即关。
import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { KB_SCHEMA_SQL } from "../src/knowledge/schema";
import { KnowledgeStore, resetJobOwnerStateForTest } from "../src/knowledge/store";
import { runIndex, getKbFailures, type KbContext, type EmbedFn } from "../src/knowledge/indexer";
import { searchKnowledge } from "../src/knowledge/search";
import { mirrorDirFor, mirrorMdPath } from "../src/knowledge/mirror";
import { CONVERTER_VERSION } from "../src/knowledge/convert";
import { runDoctor } from "../src/knowledge/doctor";
import { closeAllKbDbs, openKbDb } from "../src/knowledge/kb-db";
import { kbQuantizedScan } from "../src/knowledge/vector";
import { EMBED_DIM } from "../src/memory/schema";

const FIX = join(import.meta.dir, "fixtures/knowledge-convert");
const fakeEmbed: EmbedFn = async (texts) => texts.map(() => new Uint8Array(EMBED_DIM).fill(128));

let waPiDir: string;
let srcDir: string;
let reg: Database;
let store: KnowledgeStore;
let ctx: KbContext;
let kbId: string;

beforeEach(() => {
  waPiDir = mkdtempSync(join(tmpdir(), "kb-mirror-wapidir-"));
  srcDir = mkdtempSync(join(tmpdir(), "kb-mirror-src-"));
  reg = new Database(join(waPiDir, "knowledge.db"));
  reg.run(KB_SCHEMA_SQL);
  store = new KnowledgeStore(reg, waPiDir);
  ctx = { store, waPiDir, sse: () => {} };
  kbId = store.createKb({ folderPath: srcDir }).id;
});

afterEach(() => {
  closeAllKbDbs(); // 每库连接归缓存所有，用例间必须归位
  resetJobOwnerStateForTest(); // 存活 owner 表是模块级状态，用例间必须归位
  reg.close();
  rmSync(waPiDir, { recursive: true, force: true });
  rmSync(srcDir, { recursive: true, force: true });
});

function mirrorRoot(): string {
  return mirrorDirFor(waPiDir, kbId);
}

/** 打开每库 db 跑断言后立刻关闭（Windows 文件占用：用完自关） */
function withKbDb(fn: (db: Database) => void): void {
  const db = openKbDb(waPiDir, kbId);
  try {
    fn(db);
  } finally {
    db.close();
  }
}

function countChunks(relPath: string): number {
  let n = 0;
  withKbDb((db) => {
    n = (db.query("SELECT count(*) c FROM chunks WHERE file_path = ?").get(relPath) as { c: number }).c;
  });
  return n;
}

/**
 * 降级样本：document.xml 内嵌真实文本 + altChunk 引用损坏 MHT（无 boundary）。
 * 转换通道（docx-smart 走 altChunk/MHT）必炸 → ok:false；
 * 旧抽取通道（mammoth 读 w:t）有产出 → 降级后块存在。
 * （Ruling-6：简报原构造 document.xml 无文本，extractText 空产出 0 块，「块存在」不可能成立）
 */
function makeBrokenDocxBuffer(): Buffer {
  return Buffer.from(
    zipSync({
      "[Content_Types].xml": strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
          `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
          `<Default Extension="xml" ContentType="application/xml"/>` +
          `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
          `</Types>`,
      ),
      "_rels/.rels": strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
          `<Relationship Id="rId0" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
          `</Relationships>`,
      ),
      "word/document.xml": strToU8(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
          `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ` +
          `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
          `<w:body><w:p><w:r><w:t>损坏正文查询对象兜底抽取</w:t></w:r></w:p><w:altChunk r:id="rId1"/></w:body></w:document>`,
      ),
      "word/afchunk.mht": strToU8(
        "MIME-Version: 1.0\nContent-Type: multipart/related\n\n<html><body>损坏正文</body></html>",
      ),
    }),
  );
}

test("新文件: 转换落盘 mirror, 块 file_path=源相对路径, FTS 可检索 altChunk 正文", async () => {
  copyFileSync(join(FIX, "docx-altchunk.docx"), join(srcDir, "顾客列表.docx"));
  const r = await runIndex(ctx, kbId, fakeEmbed);
  expect(r.ok).toBe(true);
  // mirror md 落盘
  const mdPath = mirrorMdPath(mirrorRoot(), "顾客列表.docx");
  expect(existsSync(mdPath)).toBe(true);
  // 块 file_path = 源相对路径（非副本路径）
  expect(countChunks("顾客列表.docx")).toBeGreaterThan(0);
  // FTS 可检索 altChunk 正文（此前 extractText 抽不出来的内容——质量提升断言）。
  // 任务 9 起 hit.filePath 为副本内路径（源 rel + ".md"），源路径改由 sourcePath 携带
  const res = await searchKnowledge(ctx, [kbId], "查询对象", { mode: "fast" });
  const altHit = res.results.find((h) => h.sourcePath === "顾客列表.docx");
  expect(altHit).toBeTruthy();
  expect(altHit!.filePath).toBe("顾客列表.docx.md");
  // mirror_meta 统计落库：本轮 converted=1（图片样本含外联图）
  const meta = store.getMirrorMeta(kbId);
  expect(meta).not.toBeNull();
  expect(meta!.converterVersion).toBe(CONVERTER_VERSION);
  expect(meta!.converted).toBe(1);
  expect(meta!.degraded).toBe(0);
  expect(meta!.images).toBeGreaterThan(0);
});

test("快筛命中且副本被外部改写 → 下一轮以副本为准自愈", async () => {
  copyFileSync(join(FIX, "docx-altchunk.docx"), join(srcDir, "heal.docx"));
  await runIndex(ctx, kbId, fakeEmbed);
  expect(countChunks("heal.docx")).toBeGreaterThan(0);
  // 外部改写副本（源文件未动：快筛仍命中）→ 追加自愈标记
  appendFileSync(mirrorMdPath(mirrorRoot(), "heal.docx"), "\n\n自愈标记XZQ\n");
  // 重跑：快筛命中分支读副本重切（整文件短路已移除），任一块 content 含标记
  await runIndex(ctx, kbId, fakeEmbed);
  withKbDb((db) => {
    const n = (db.query("SELECT count(*) c FROM chunks WHERE content LIKE '%自愈标记XZQ%'").get() as { c: number }).c;
    expect(n).toBeGreaterThan(0);
  });
});

test("降级: 转换失败回退 extractText, 无副本, 块存在, failed 清单含该文件, 检索不抛错", async () => {
  writeFileSync(join(srcDir, "broken.docx"), makeBrokenDocxBuffer());
  const r = await runIndex(ctx, kbId, fakeEmbed);
  expect(r.ok).toBe(true);
  // 无副本（降级信号：转换未落盘）
  expect(existsSync(mirrorMdPath(mirrorRoot(), "broken.docx"))).toBe(false);
  // 块存在（降级抽取有产出）
  expect(countChunks("broken.docx")).toBeGreaterThan(0);
  // failed 清单含该文件（转换失败记入）
  const failures = getKbFailures(kbId);
  expect(failures.some((f) => f.path === "broken.docx")).toBe(true);
  // 检索不抛错
  const res = await searchKnowledge(ctx, [kbId], "损坏正文", { mode: "fast" });
  expect(res.found === true || res.found === false).toBe(true);
  // mirror_meta：本轮 degraded=1、converted=0
  const meta = store.getMirrorMeta(kbId)!;
  expect(meta.degraded).toBe(1);
  expect(meta.converted).toBe(0);
});

test("源文件删除 → 副本与块一并清理", async () => {
  // 伴生文件避免归零保护（目录仅剩 0 个可索引文件时拒绝整轮，见 runIndex 归零突变保护）
  writeFileSync(join(srcDir, "keep.md"), "# 保留文件\n伴生内容。");
  copyFileSync(join(FIX, "docx-altchunk.docx"), join(srcDir, "gone.docx"));
  await runIndex(ctx, kbId, fakeEmbed);
  const mdPath = mirrorMdPath(mirrorRoot(), "gone.docx");
  expect(existsSync(mdPath)).toBe(true); // 首轮副本已在
  expect(countChunks("gone.docx")).toBeGreaterThan(0);
  // 删除源文件 → 重跑
  rmSync(join(srcDir, "gone.docx"));
  const r = await runIndex(ctx, kbId, fakeEmbed);
  expect(r.ok).toBe(true);
  // 副本与块一并清理
  expect(existsSync(mdPath)).toBe(false);
  expect(countChunks("gone.docx")).toBe(0);
});

// ===== 审查修复轮 1（C-1/I-1/I-2）=====

// C-1 回归锁（两条触发路径）：空白文本 → chunkDocument 产 0 块，reuse.size(0) === chunks.length(0)
// 不得误判「全复用」跳过 deleteFileRows（否则旧块残留、自愈静默失效）
test("源文件内容清空 → 旧块删除零残留（零块不误判全复用）", async () => {
  writeFileSync(join(srcDir, "empty.md"), "# 有点内容\n\n正文段落。");
  await runIndex(ctx, kbId, fakeEmbed);
  expect(countChunks("empty.md")).toBeGreaterThan(0);
  // 源清空 → 快筛不命中 → 直通转换产出空副本 → 0 块 → hasOld 必须删旧块
  writeFileSync(join(srcDir, "empty.md"), "");
  const r = await runIndex(ctx, kbId, fakeEmbed);
  expect(r.ok).toBe(true);
  expect(countChunks("empty.md")).toBe(0);
});

test("副本被外部清空 → 快筛命中以空副本为准, 旧块删除零残留", async () => {
  writeFileSync(join(srcDir, "wipe.md"), "# 原内容\n\n正文段落。");
  await runIndex(ctx, kbId, fakeEmbed);
  expect(countChunks("wipe.md")).toBeGreaterThan(0);
  // 快筛命中（源未变）分支 readMirrorMd 返回 "" 非 null——不触发转换重建，以空副本为准重切
  writeFileSync(mirrorMdPath(mirrorRoot(), "wipe.md"), "");
  const r = await runIndex(ctx, kbId, fakeEmbed);
  expect(r.ok).toBe(true);
  expect(countChunks("wipe.md")).toBe(0);
});

// I-1a 回归锁（R-10 直通分支）：零变更轮全命中时既有行 rowid/id/hash 不变（不删不插，
// rowid 稳定 = 量化 shadow 无需重建）；且语义通道（量化扫描）仍命中全部块
test("零变更轮直通: 全命中时既有行 rowid 不变, 量化扫描仍全命中", async () => {
  // 量化要求合法 float32 向量（字节填充会被扩展判为非法 blob，见 knowledge-indexer 既有锁测）
  const floatEmbed: EmbedFn = async (texts) =>
    texts.map(() => new Uint8Array(new Float32Array(new Array(EMBED_DIM).fill(0.1)).buffer));
  writeFileSync(join(srcDir, "stable.md"), "# 稳定内容\n\n第一段。\n\n第二段。");
  await runIndex(ctx, kbId, floatEmbed);
  const readRows = () => {
    let rows: Array<{ rowid: number; id: string; h: string }> = [];
    withKbDb((db) => {
      rows = db
        .query("SELECT rowid, id, content_hash h FROM chunks WHERE file_path = 'stable.md' ORDER BY rowid")
        .all() as Array<{ rowid: number; id: string; h: string }>;
    });
    return rows;
  };
  const before = readRows();
  expect(before.length).toBeGreaterThan(0);
  await runIndex(ctx, kbId, floatEmbed); // 零变更轮：快筛命中 + 副本 hash 全命中 → 直通
  expect(readRows()).toEqual(before); // rowid/id/hash 全部不变（不删不插）
  // 量化 shadow 未重建也必须对齐：语义通道仍命中全部块
  const vec = new Uint8Array(new Float32Array(new Array(EMBED_DIM).fill(0.1)).buffer);
  withKbDb((db) => {
    const hits = kbQuantizedScan(db, vec, 50);
    expect(hits.length).toBe(before.length);
  });
});

// I-2：快筛命中且副本 hash 全命中轮零嵌入（「命中不重嵌」直接断言）
test("快筛命中且 hash 全命中轮零嵌入调用", async () => {
  writeFileSync(join(srcDir, "noop.md"), "# 无变更\n\n零嵌入内容。");
  await runIndex(ctx, kbId, fakeEmbed); // 首轮全嵌
  const spy = mock(fakeEmbed);
  await runIndex(ctx, kbId, spy); // 源未变 → 快筛命中读副本重切 → hash 全命中 → 不重嵌
  expect(spy.mock.calls.length).toBe(0);
});

// ===== 最终审查修复（C-1 / I-2 / I-3）=====

// C-1 回归锁：正常索引 → 源替换为损坏 docx（转换失败降级）→ 旧副本必须被清（规格决策 2
// 「降级且无副本」），否则下一轮快筛命中读到旧副本、块内容静默回退旧版且永不自愈
test("转换降级清旧副本: 无副本不变量, 后续轮不回退旧内容", async () => {
  copyFileSync(join(FIX, "docx-altchunk.docx"), join(srcDir, "victim.docx"));
  await runIndex(ctx, kbId, fakeEmbed);
  expect(countChunks("victim.docx")).toBeGreaterThan(0);
  expect(existsSync(mirrorMdPath(mirrorRoot(), "victim.docx"))).toBe(true);
  // 源替换为损坏 docx（mtime/size 变 → 快筛不命中）→ 转换失败降级
  writeFileSync(join(srcDir, "victim.docx"), makeBrokenDocxBuffer());
  const r2 = await runIndex(ctx, kbId, fakeEmbed);
  expect(r2.ok).toBe(true);
  // 降级后无副本（修复前旧副本残留 → 红）
  expect(existsSync(mirrorMdPath(mirrorRoot(), "victim.docx"))).toBe(false);
  expect(countChunks("victim.docx")).toBeGreaterThan(0); // 降级抽取有产出
  // 下一轮源未变（快筛命中）：不得读到旧副本把块内容回退旧版
  await runIndex(ctx, kbId, fakeEmbed);
  expect(existsSync(mirrorMdPath(mirrorRoot(), "victim.docx"))).toBe(false);
  // 块内容维持降级抽取产出（修复前会回退成旧副本的 markdown，不含「兜底抽取」串）
  withKbDb((db) => {
    const n = (db.query("SELECT count(*) c FROM chunks WHERE content LIKE '%兜底抽取%'").get() as { c: number }).c;
    expect(n).toBeGreaterThan(0);
  });
});

// I-2 回归锁：重转换清旧 assets——8 图 → 1 图后 assets 目录只剩 1 文件、doctor 无孤儿报告
test("重转换清旧 assets: 8图→1图后 assets 只剩新图, doctor 无孤儿", async () => {
  copyFileSync(join(FIX, "docx-normal.docx"), join(srcDir, "multi.docx"));
  await runIndex(ctx, kbId, fakeEmbed);
  const assetsDir = join(mirrorRoot(), "_assets", "multi.docx");
  const before = readdirSync(assetsDir).length;
  expect(before).toBeGreaterThan(1); // 8 图样本
  // 源替换为 1 图样本 → 重转换（快筛不命中）
  copyFileSync(join(FIX, "docx-altchunk.docx"), join(srcDir, "multi.docx"));
  const r2 = await runIndex(ctx, kbId, fakeEmbed);
  expect(r2.ok).toBe(true);
  expect(readdirSync(assetsDir).length).toBe(1); // 修复前残留 8 个（红）
  // doctor 不报孤儿 assets
  const report = await runDoctor(ctx);
  const orphanIssues = report.issues.filter((i) => /_assets 资源目录/.test(i.message));
  expect(orphanIssues).toEqual([]);
});

// I-3 回归锁：mirror_meta.converted 为存量口径（库内有副本的文件总数）——
// 零变更轮不减（修复前 = 本轮增量 0 → 红）、增量消化新文件后 +1
test("mirror_meta.converted 存量口径: 零变更轮不减, 增量后累加", async () => {
  copyFileSync(join(FIX, "docx-altchunk.docx"), join(srcDir, "a.docx"));
  writeFileSync(join(srcDir, "b.txt"), "纯文本内容甲。");
  await runIndex(ctx, kbId, fakeEmbed);
  expect(store.getMirrorMeta(kbId)!.converted).toBe(2); // 首轮全量 = 存量 2
  await runIndex(ctx, kbId, fakeEmbed); // 零变更轮：快筛命中副本全在
  expect(store.getMirrorMeta(kbId)!.converted).toBe(2); // 修复前 = 0（红）
  writeFileSync(join(srcDir, "c.txt"), "新增文本乙。");
  await runIndex(ctx, kbId, fakeEmbed);
  expect(store.getMirrorMeta(kbId)!.converted).toBe(3); // 存量 3
  expect(store.getMirrorMeta(kbId)!.degraded).toBe(0);
});
