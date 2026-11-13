// 索引器镜像接入测试（任务 8，规格 §5.3/§6.8/§6.9）：
//   1. 新文件：转换落盘 mirror + 块 file_path=源相对路径 + FTS 可检索 altChunk 正文（质量提升锁）；
//   2. 自愈：快筛命中（源未变）且副本被外部改写 → 下一轮以副本为准重切；
//   3. 降级：转换失败回退 extractText，无副本、块存在、failed 清单含该文件、检索不抛错；
//   4. 删除：源文件删除 → 副本与块一并清理；
//   5. mirror_meta 统计落库（converterVersion/converted/degraded/images）。
// 夹具模式与 knowledge-watcher.test.ts 一致：临时源目录 + fake embed + 每库 db 断言即开即关。
import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
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
import { closeAllKbDbs, openKbDb } from "../src/knowledge/kb-db";
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
  // FTS 可检索 altChunk 正文（此前 extractText 抽不出来的内容——质量提升断言）
  const res = await searchKnowledge(ctx, [kbId], "查询对象", { mode: "fast" });
  expect(res.results.some((h) => h.filePath === "顾客列表.docx")).toBe(true);
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
