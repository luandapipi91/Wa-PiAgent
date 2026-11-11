// knowledge_read 单测：按 file_path 读该文件已抽取全文、按 chunk_id 读上下文块。
// 与 knowledge-search 测试同构：fake 向量手工插块建库（不经模型/ indexer），只验读取路径。
import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KB_SCHEMA_SQL } from "../src/knowledge/schema";
import { KnowledgeStore } from "../src/knowledge/store";
import { closeAllKbDbs, openKbDb } from "../src/knowledge/kb-db";
import type { KbContext } from "../src/knowledge/index";
import { readKnowledge } from "../src/knowledge/read";

let waPiDir: string;
let reg: Database;
let store: KnowledgeStore;
let ctx: KbContext;
let kbId: string;

function insert(db: Database, filePath: string, start: number, end: number, content: string): string {
  const id = randomUUID();
  db.run(
    `INSERT INTO chunks (id, file_path, file_type, title, breadcrumb, start_line, end_line,
       content, prefix_content, content_hash, file_mtime, file_size, updated_at)
     VALUES (?, ?, 'docx', NULL, NULL, ?, ?, ?, ?, ?, 1, 1, 1)`,
    [id, filePath, start, end, content, content, randomUUID()],
  );
  return id;
}

beforeEach(() => {
  waPiDir = mkdtempSync(join(tmpdir(), "kb-read-"));
  reg = new Database(join(waPiDir, "knowledge.db"));
  reg.run(KB_SCHEMA_SQL);
  store = new KnowledgeStore(reg, waPiDir);
  ctx = { store, waPiDir, sse: () => {} };
  kbId = store.createKb({ folderPath: join(waPiDir, "src"), name: "读取库" }).id;
  const db = openKbDb(waPiDir, kbId);
  db.run("DELETE FROM chunks");
  insert(db, "docs/门店挂靠.docx", 1, 10, "门店挂靠 背景");
  insert(db, "docs/门店挂靠.docx", 11, 20, "门店A1 挂靠到品牌B");
  insert(db, "docs/门店挂靠.docx", 21, 30, "会员资料处理规则");
  insert(db, "docs/其他.docx", 1, 10, "其他文档正文");
  db.close();
  store.updateStatus(kbId, "ready");
});

afterEach(() => {
  closeAllKbDbs();
  reg.close();
  rmSync(waPiDir, { recursive: true, force: true });
});

test("按 file_path 返回该文件全部块（原文顺序、带行号范围与库根绝对路径）", async () => {
  const r = await readKnowledge(ctx, [kbId], { filePath: "docs/门店挂靠.docx" });
  expect(r.found).toBe(true);
  expect(r.kbName).toBe("读取库");
  expect(r.filePath).toBe("docs/门店挂靠.docx");
  expect(r.filePathAbs).toBe(join(waPiDir, "src", "docs/门店挂靠.docx"));
  expect(r.content).toContain("门店挂靠 背景");
  expect(r.content).toContain("会员资料处理规则");
  expect(r.content).not.toContain("其他文档正文");
  expect(r.startLine).toBe(1);
  expect(r.endLine).toBe(30);
  expect(r.chunkCount).toBe(3);
});

test("按绝对路径读取（自动匹配库根换算成相对路径）", async () => {
  const abs = join(waPiDir, "src", "docs", "门店挂靠.docx");
  const r = await readKnowledge(ctx, [kbId], { filePath: abs });
  expect(r.found).toBe(true);
  expect(r.filePath).toBe("docs/门店挂靠.docx");
});

test("按 chunk_id 只取该块 ±N 块上下文（before/after）", async () => {
  const db = openKbDb(waPiDir, kbId);
  const id = db.query("SELECT id FROM chunks WHERE start_line = 11").get() as { id: string };
  db.close();
  const r = await readKnowledge(ctx, [kbId], { chunkId: id.id, before: 1, after: 0 });
  expect(r.found).toBe(true);
  expect(r.content).toContain("门店挂靠 背景");
  expect(r.content).toContain("门店A1 挂靠到品牌B");
  expect(r.content).not.toContain("会员资料处理规则");
});

test("超出 maxChars 时截断并标记 truncated", async () => {
  const r = await readKnowledge(ctx, [kbId], { filePath: "docs/门店挂靠.docx", maxChars: 20 });
  expect(r.found).toBe(true);
  expect(r.truncated).toBe(true);
  expect((r.content ?? "").length).toBeLessThanOrEqual(20);
});

test("文件不存在 / chunk 不存在 / 库未绑定 分别给出明确原因", async () => {
  expect((await readKnowledge(ctx, [kbId], { filePath: "docs/nope.docx" })).reason).toBe("file_not_found");
  expect((await readKnowledge(ctx, [kbId], { chunkId: "nope" })).reason).toBe("chunk_not_found");
  expect((await readKnowledge(ctx, [], { filePath: "docs/门店挂靠.docx" })).reason).toBe("kb_not_bound");
});

test("kbId 指定库时只在该库查找", async () => {
  const r = await readKnowledge(ctx, [kbId], { filePath: "docs/门店挂靠.docx", kbId });
  expect(r.found).toBe(true);
  const miss = await readKnowledge(ctx, [kbId], { filePath: "docs/门店挂靠.docx", kbId: "other" });
  expect(miss.found).toBe(false);
  expect(miss.reason).toBe("kb_not_bound");
});
