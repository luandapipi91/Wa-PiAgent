// 任务 9：检索/读取指向 markdown 副本（TDD）。
//   1. search hit：有副本的文件 filePath=副本内路径（源 rel + ".md"）且副本文件存在，
//      sourcePath=源相对路径，filePathAbs=副本绝对路径；
//   2. knowledge_read(filePath=源 rel)：副本存在 → 读副本全文返回（file_path_abs 指副本）；
//      副本形态入参（hit.filePath，源 rel + ".md"）同样接受（去 .md 后定位同一文件）；
//   3. chunkId 模式：content 仍是按块 ±N 的行窗上下文，但库里有副本时 file_path_abs 指副本；
//   4. 无副本（降级抽取文件）→ 回退 chunks.content，不抛错，file_path_abs=源绝对路径。
// 建库场景与 knowledge-indexer-mirror.test.ts（任务 8）同构：临时源目录 + fake embed +
// docx-altchunk fixture（转换通道有产出）/ 损坏 altChunk docx（降级通道兜底）。
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { KB_SCHEMA_SQL } from "../src/knowledge/schema";
import { KnowledgeStore, resetJobOwnerStateForTest } from "../src/knowledge/store";
import { runIndex, type KbContext, type EmbedFn } from "../src/knowledge/indexer";
import { searchKnowledge } from "../src/knowledge/search";
import { readKnowledge } from "../src/knowledge/read";
import { mirrorDirFor, mirrorMdPath } from "../src/knowledge/mirror";
import { closeAllKbDbs } from "../src/knowledge/kb-db";
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
  waPiDir = mkdtempSync(join(tmpdir(), "kb-read-mirror-wapidir-"));
  srcDir = mkdtempSync(join(tmpdir(), "kb-read-mirror-src-"));
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
  return mirrorDirFor(srcDir);
}

/** 建一个含 markdown 副本的库（docx-altchunk fixture，转换通道产出副本 + altChunk 正文） */
async function buildConvertedKb(): Promise<string> {
  copyFileSync(join(FIX, "docx-altchunk.docx"), join(srcDir, "顾客列表.docx"));
  const r = await runIndex(ctx, kbId, fakeEmbed);
  expect(r.ok).toBe(true);
  expect(existsSync(mirrorMdPath(mirrorRoot(), "顾客列表.docx"))).toBe(true);
  return "顾客列表.docx";
}

/**
 * 降级样本（与任务 8 同构造）：document.xml 内嵌真实文本 + altChunk 引用损坏 MHT（无 boundary）。
 * 转换通道必炸 → 无副本；旧抽取通道（mammoth 读 w:t）有产出 → 降级后块存在。
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

describe("检索/读取指向副本", () => {
  test("search hit: filePath=副本相对路径(.md 结尾) 且文件存在, sourcePath=源相对路径", async () => {
    const srcRel = await buildConvertedKb();
    const res = await searchKnowledge(ctx, [kbId], "查询对象", { mode: "fast" });
    const hit = res.results.find((h) => h.filePath === srcRel + ".md");
    expect(hit).toBeTruthy();
    expect(existsSync(join(mirrorRoot(), hit!.filePath))).toBe(true); // 副本文件真实存在
    expect(hit!.sourcePath).toBe(srcRel); // 源相对路径单独携带（读库/换算用）
    expect(hit!.filePathAbs).toBe(mirrorMdPath(mirrorRoot(), srcRel)); // 副本绝对路径
  });

  test("knowledge_read(filePath=源rel): 返回副本内容, file_path_abs=副本绝对路径", async () => {
    const srcRel = await buildConvertedKb();
    const r = await readKnowledge(ctx, [kbId], { filePath: srcRel });
    expect(r.found).toBe(true);
    expect(r.content).toContain("查询对象"); // 副本全文（含 altChunk 正文）
    expect(r.filePathAbs).toBe(mirrorMdPath(mirrorRoot(), srcRel));
    expect(r.filePath).toBe(srcRel);
  });

  test("knowledge_read 接受副本形态入参(hit.filePath, 源rel+.md) → 去 .md 定位同一文件", async () => {
    const srcRel = await buildConvertedKb();
    const r = await readKnowledge(ctx, [kbId], { filePath: srcRel + ".md" });
    expect(r.found).toBe(true);
    expect(r.content).toContain("查询对象");
    expect(r.filePathAbs).toBe(mirrorMdPath(mirrorRoot(), srcRel));
  });

  test("往返: search hit.filePathAbs 回传 knowledge_read → 返回副本内容(不 file_not_found)", async () => {
    // KB_READ_PARAMS_SCHEMA 承诺 file_path 接受绝对路径（file_path_abs），bridge 错误文案也在引导
    // 此用法；有副本时 filePathAbs 是 mirror 目录下的绝对路径（不在库根内），必须能换算回源 rel
    const srcRel = await buildConvertedKb();
    const res = await searchKnowledge(ctx, [kbId], "查询对象", { mode: "fast" });
    const hit = res.results.find((h) => h.filePath === srcRel + ".md");
    expect(hit).toBeTruthy();
    expect(hit!.filePathAbs).toBeTruthy();
    const r = await readKnowledge(ctx, [kbId], { filePath: hit!.filePathAbs });
    expect(r.found).toBe(true); // 修前 file_not_found（回归锁）
    expect(r.content).toContain("查询对象");
    expect(r.filePath).toBe(srcRel);
    expect(r.filePathAbs).toBe(mirrorMdPath(mirrorRoot(), srcRel));
  });

  test("knowledge_read(chunkId): content 仍为按块上下文, 有副本时 file_path_abs 指副本", async () => {
    const srcRel = await buildConvertedKb();
    const res = await searchKnowledge(ctx, [kbId], "查询对象", { mode: "fast" });
    const chunkId = res.results[0].provenance.chunk_id;
    const r = await readKnowledge(ctx, [kbId], { chunkId });
    expect(r.found).toBe(true);
    expect(r.filePath).toBe(srcRel);
    expect(r.filePathAbs).toBe(mirrorMdPath(mirrorRoot(), srcRel)); // 副本路径补进返回
  });

  test("无副本(降级文件) → 回退 chunks.content, file_path_abs=源绝对路径, 不抛错", async () => {
    writeFileSync(join(srcDir, "broken.docx"), makeBrokenDocxBuffer());
    const r0 = await runIndex(ctx, kbId, fakeEmbed);
    expect(r0.ok).toBe(true);
    expect(existsSync(mirrorMdPath(mirrorRoot(), "broken.docx"))).toBe(false); // 降级：无副本
    const r = await readKnowledge(ctx, [kbId], { filePath: "broken.docx" });
    expect(r.found).toBe(true);
    expect(r.content).toContain("损坏正文查询对象兜底抽取"); // 来自 chunks 表（降级抽取产出）
    expect(r.filePathAbs).toBe(join(srcDir, "broken.docx")); // 维持源绝对路径
    // 检索侧同样不抛错：降级 hit 维持源路径出参
    const res = await searchKnowledge(ctx, [kbId], "损坏正文", { mode: "fast" });
    const hit = res.results.find((h) => h.sourcePath === "broken.docx");
    expect(hit).toBeTruthy();
    expect(hit!.filePath).toBe("broken.docx"); // 无副本 → 不加 .md 后缀
    expect(hit!.filePathAbs).toBe(join(srcDir, "broken.docx"));
  });
});

// I-1 路径遍历防御（最终审查）：filePath 外部输入直通 readMirrorMd 的候选路径——
// 守卫后绝对路径与 .. 段一律读不出 mirror 外文件（防御在 mirror.ts 三入口统一实现）
describe("filePath 路径遍历防御", () => {
  test("filePath 含 .. 段 → 不读出 mirror 外文件", async () => {
    await buildConvertedKb();
    // mirror 外诱饵：.. 串用 relative(mirrorRoot, target) 精确构造——守卫失效时
    // readMirrorMd(join(mirrorDir, rel)) 恰好解析到诱饵，真的读得出机密（RED 确定性）
    const outside = mkdtempSync(join(tmpdir(), "kb-read-outside-"));
    try {
      const target = join(outside, "victim-secret.md");
      writeFileSync(target, "机密内容不应被读出");
      const rel = relative(mirrorRoot(), target);
      const res = await readKnowledge(ctx, [kbId], { filePath: rel });
      // 不返回 mirror 外内容（found=false 走 file_not_found，或命中库内正常副本但 content 不含诱饵）
      if (res.found) expect(res.content).not.toContain("机密内容不应被读出");
      else expect(res.reason).toBe("file_not_found");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("filePath 绝对路径指向 mirror 外 → 不读出外部文件", async () => {
    await buildConvertedKb();
    const outside = mkdtempSync(join(tmpdir(), "kb-read-outside2-"));
    try {
      writeFileSync(join(outside, "victim-secret.md"), "机密内容不应被读出");
      const res = await readKnowledge(ctx, [kbId], { filePath: join(outside, "victim-secret.md") });
      if (res.found) expect(res.content).not.toContain("机密内容不应被读出");
      else expect(res.reason).toBe("file_not_found");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
