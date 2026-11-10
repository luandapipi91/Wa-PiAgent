import { test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { KB_SCHEMA_SQL } from "../src/knowledge/schema";
import { KnowledgeStore } from "../src/knowledge/store";
import { openKbDb } from "../src/knowledge/kb-db";
import { kbDbPath } from "../src/knowledge/paths";

// store 测试：:memory: 登记库
let store: KnowledgeStore;
beforeEach(() => {
  const db = new Database(":memory:");
  db.run(KB_SCHEMA_SQL);
  store = new KnowledgeStore(db, "/tmp/wa-pi-test");
});

test("createKb 不填名称/描述时用文件夹 basename 与默认描述模板", () => {
  const kb = store.createKb({ folderPath: "D:/资料/产品文档", name: "", description: "" });
  expect(kb.name).toBe("产品文档");
  expect(kb.description).toBe("来自文件夹「产品文档」的资料索引，回答与「产品文档」相关的问题前可检索本库");
});
test("createKb 显式名称/描述优先生效且 status 初始为 scanning", () => {
  const kb = store.createKb({ folderPath: "D:/x", name: "需求库", description: "历年需求" });
  expect(kb.name).toBe("需求库"); expect(kb.status).toBe("scanning"); expect(kb.autoWatch).toBe(true);
});
test("deleteKb 级联清理：删除每库 db 文件与 indexing_jobs", async () => {
  const kb = store.createKb({ folderPath: "D:/x", name: "a", description: "" });
  // 在 kbDbPath 位置造一个真实文件
  const p = kbDbPath("/tmp/wa-pi-test", kb.id);
  await Bun.write(p, "x");
  store.deleteKb(kb.id);
  expect(store.getKb(kb.id)).toBeNull();
  expect(existsSync(p)).toBe(false);
});
test("updateJobProgress 与 stuck 判定", () => {
  const kb = store.createKb({ folderPath: "D:/x", name: "a", description: "" });
  store.startJob(kb.id, "scanning");
  store.updateJobProgress(kb.id, { phase: "embedding", filesTotal: 100, filesDone: 40, chunksDone: 900 });
  const job = store.getJob(kb.id)!;
  expect(job.filesDone).toBe(40);
  expect(store.isJobStuck(kb.id, Date.now() - 11 * 60_000)).toBe(true);   // 超过 10 分钟
  expect(store.isJobStuck(kb.id, Date.now() - 3 * 60_000)).toBe(false);
});

test("chunksTotal 持久化：job 行与 KbInfo.progress 都带上块总量", () => {
  const kb = store.createKb({ folderPath: "D:/x", name: "a", description: "" });
  store.startJob(kb.id, "scanning");
  store.updateJobProgress(kb.id, { phase: "embedding", filesTotal: 3, filesDone: 3, chunksDone: 64, chunksTotal: 200 });
  expect(store.getJob(kb.id)!.chunksTotal).toBe(200);
  expect(store.getKb(kb.id)!.progress!.chunksTotal).toBe(200);
});

test("旧库迁移：indexing_jobs 缺 chunks_total 列时自动补齐（已发布库不能炸）", () => {
  // 模拟 0.9.x 已发布的 v1 库结构：没有 chunks_total 列
  const legacy = new Database(":memory:");
  legacy.run(`CREATE TABLE knowledge_bases (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
    folder_path TEXT NOT NULL, status TEXT NOT NULL, file_count INTEGER DEFAULT 0,
    chunk_count INTEGER DEFAULT 0, failed_count INTEGER DEFAULT 0, embed_meta TEXT,
    auto_watch INTEGER NOT NULL DEFAULT 1, last_indexed_at INTEGER, created_at INTEGER NOT NULL)`);
  legacy.run(`CREATE TABLE indexing_jobs (
    kb_id TEXT PRIMARY KEY REFERENCES knowledge_bases(id) ON DELETE CASCADE,
    phase TEXT NOT NULL, files_total INTEGER, files_done INTEGER, chunks_done INTEGER,
    skip_stats TEXT, last_progress_at INTEGER NOT NULL, created_at INTEGER NOT NULL)`);
  const legacyStore = new KnowledgeStore(legacy, "/tmp/wa-pi-test");
  const kb = legacyStore.createKb({ folderPath: "D:/x", name: "旧库", description: "" });
  legacyStore.startJob(kb.id, "scanning");
  legacyStore.updateJobProgress(kb.id, { phase: "embedding", chunksTotal: 12, chunksDone: 3 });
  expect(legacyStore.getJob(kb.id)!.chunksTotal).toBe(12);
  legacy.close();
});
