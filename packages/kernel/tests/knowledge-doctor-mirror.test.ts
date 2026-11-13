// doctor 镜像副本完整性检查测试（任务 10）：
//   1. 孤儿 _assets 目录（无对应 md）→ 报告列出，非 error 级；
//   2. 建库场景引用↔文件对齐 → 无副本类告警；
//   3. 降级文件（索引有块、副本缺失）→ 报告列清单，info 级；
//   4. 残留副本（副本存在、索引无该文件）→ 报告列清单，非 error 级；
//   5. 副本内引用断链 → 报告含引用统计与断链路径。
// 严重度语义：副本类问题可自愈或无害，一律不置 blocking 级。
// 夹具模式与 knowledge-indexer-mirror.test.ts 一致：临时源目录 + fake embed + 即开即关。
import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, strToU8 } from "fflate";
import { KB_SCHEMA_SQL } from "../src/knowledge/schema";
import { KnowledgeStore, resetJobOwnerStateForTest } from "../src/knowledge/store";
import { runIndex, type KbContext, type EmbedFn } from "../src/knowledge/indexer";
import { closeAllKbDbs } from "../src/knowledge/kb-db";
import { runDoctor } from "../src/knowledge/doctor";
import { mirrorDirFor, mirrorMdPath } from "../src/knowledge/mirror";
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
  waPiDir = mkdtempSync(join(tmpdir(), "kb-doctor-mirror-wapidir-"));
  srcDir = mkdtempSync(join(tmpdir(), "kb-doctor-mirror-src-"));
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

/**
 * 降级样本（与 knowledge-indexer-mirror.test.ts 同构造）：转换通道必炸 → 降级后块存在、无副本。
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

test("孤儿 _assets 目录(无对应 md) → 报告列出, 非 error 级", async () => {
  copyFileSync(join(FIX, "docx-altchunk.docx"), join(srcDir, "with-img.docx"));
  await runIndex(ctx, kbId, fakeEmbed);
  // 手放无主 assets 目录（对应副本 md 不存在）
  mkdirSync(join(mirrorRoot(), "_assets", "ghost.docx"), { recursive: true });
  writeFileSync(join(mirrorRoot(), "_assets", "ghost.docx", "x.png"), "x");
  const report = await runDoctor(ctx);
  const issue = report.issues.find(
    (i) => i.message.includes("_assets") && i.message.includes("ghost.docx"),
  );
  expect(issue).toBeTruthy();
  expect(issue!.severity).not.toBe("blocking");
});

test("建库场景引用↔文件对齐 → 无副本类告警", async () => {
  copyFileSync(join(FIX, "docx-altchunk.docx"), join(srcDir, "ok.docx"));
  await runIndex(ctx, kbId, fakeEmbed);
  expect(existsSync(mirrorMdPath(mirrorRoot(), "ok.docx"))).toBe(true);
  const report = await runDoctor(ctx);
  // 无任何 mirror 副本类告警（降级/残留/断链/孤儿 assets 均不出现）
  expect(report.issues.filter((i) => /副本|mirror|_assets/.test(i.message))).toEqual([]);
});

test("副本缺失但索引正常(降级文件) → 报告列 degraded 清单, info 级", async () => {
  writeFileSync(join(srcDir, "broken.docx"), makeBrokenDocxBuffer());
  await runIndex(ctx, kbId, fakeEmbed);
  // 前置：降级后块存在、无副本
  expect(existsSync(mirrorMdPath(mirrorRoot(), "broken.docx"))).toBe(false);
  const report = await runDoctor(ctx);
  const issue = report.issues.find((i) => i.message.includes("broken.docx"));
  expect(issue).toBeTruthy();
  expect(issue!.severity).toBe("info");
});

test("副本存在但索引无该文件(残留副本) → 报告列清单, 非 error 级", async () => {
  writeFileSync(join(srcDir, "keep.md"), "# 保留\n正文内容。");
  await runIndex(ctx, kbId, fakeEmbed);
  // 手放索引中不存在的副本 md（模拟清理中断的残留）
  mkdirSync(join(mirrorRoot(), "stale"), { recursive: true });
  writeFileSync(join(mirrorRoot(), "stale", "ghost.md"), "# 残留\n");
  const report = await runDoctor(ctx);
  const issue = report.issues.find((i) => i.message.includes("stale/ghost.md"));
  expect(issue).toBeTruthy();
  expect(issue!.severity).not.toBe("blocking");
});

test("副本内引用断链 → 报告含引用统计与断链路径", async () => {
  copyFileSync(join(FIX, "docx-altchunk.docx"), join(srcDir, "ok.docx"));
  await runIndex(ctx, kbId, fakeEmbed);
  // 该 fixture 转换产物 md 内无图片引用位，手写注入一条与产物同源的相对引用（根级 md → _assets/...）
  appendFileSync(mirrorMdPath(mirrorRoot(), "ok.docx"), "\n\n![缺图](_assets/ok.docx/missing.png)\n");
  // 删掉被引用的图片资产 → 断链
  rmSync(join(mirrorRoot(), "_assets", "ok.docx"), { recursive: true, force: true });
  const report = await runDoctor(ctx);
  const issue = report.issues.find((i) => /断链/.test(i.message));
  expect(issue).toBeTruthy();
  expect(issue!.severity).not.toBe("blocking");
  expect(issue!.message).toContain("missing.png");
});
