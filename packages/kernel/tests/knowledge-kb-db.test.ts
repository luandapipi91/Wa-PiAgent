import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KB_SCHEMA_SQL } from "../src/knowledge/schema";
import { KnowledgeStore } from "../src/knowledge/store";
import { openKbDb, openKbDbExisting, evictKbDb, closeAllKbDbs } from "../src/knowledge/kb-db";
import { kbDbPath } from "../src/knowledge/paths";
import { searchKnowledge } from "../src/knowledge/search";
import { runIndex, type EmbedFn } from "../src/knowledge/indexer";
import type { KbContext } from "../src/knowledge/index";

// 每库 db 连接生命周期（S7）：
//   · 同库复用一条连接（索引与检索并发时不至于每次重开、重跑 DDL）；
//   · 缓存项的失效由「命中探活」兜底——既有大量测试（withKbDb）用完即 close，
//     纯缓存会返回已关闭连接；
//   · 删库前显式 evict，Windows 上文件才删得掉（句柄占用）；
//   · 检索路径的库文件缺失不再被当成「空库 → 未找到」，而是显式标记跳过。

let dir: string;
let srcDir: string;
let reg: Database;
let store: KnowledgeStore;
let ctx: KbContext;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kb-db-wapidir-"));
  srcDir = mkdtempSync(join(tmpdir(), "kb-db-src-"));
  writeFileSync(join(srcDir, "a.md"), "# A\n\n内容甲。");
  reg = new Database(join(dir, "knowledge.db"));
  reg.run(KB_SCHEMA_SQL);
  store = new KnowledgeStore(reg, dir);
  ctx = { store, waPiDir: dir, sse: () => {} };
});

afterEach(() => {
  closeAllKbDbs(); // 模块级缓存是跨用例状态，必须归位（否则临时目录里留句柄）
  reg.close();
  rmSync(dir, { recursive: true, force: true });
  rmSync(srcDir, { recursive: true, force: true });
});

/** 删掉某库的 db 文件及其 WAL/SHM 伴生文件（模拟「库文件丢失」） */
function removeKbFiles(kbId: string): void {
  const p = kbDbPath(dir, kbId);
  for (const f of [p, `${p}-wal`, `${p}-shm`]) rmSync(f, { force: true });
}

test("openKbDb 缓存连接：同一库两次打开返回同一实例，evict 后重建", () => {
  const a = openKbDb(dir, "kb_1");
  const b = openKbDb(dir, "kb_1");
  expect(a).toBe(b);
  evictKbDb("kb_1");
  const c = openKbDb(dir, "kb_1");
  expect(c).not.toBe(a);
  // 旧句柄已被 evict 关闭，新连接照常可用
  expect(() => a.close()).not.toThrow();
  expect((c.query("SELECT COUNT(*) c FROM chunks").get() as { c: number }).c).toBe(0);
});

test("缓存命中前探活：调用方 close() 后再次打开返回可用新连接", () => {
  const a = openKbDb(dir, "kb_probe");
  a.close(); // 既有 withKbDb 模式：用完即关
  const b = openKbDb(dir, "kb_probe");
  expect(b).not.toBe(a);
  // 重建的连接是可用的（未被缓存的已关闭句柄污染）
  expect((b.query("SELECT 1 AS ok").get() as { ok: number }).ok).toBe(1);
});

test("库文件不存在时 openKbDbExisting 抛错，不静默新建空库", () => {
  expect(() => openKbDbExisting(dir, "kb_missing")).toThrow(/不存在/);
  // 关键：未创建文件，也没被当成空库
  expect(existsSync(kbDbPath(dir, "kb_missing"))).toBe(false);
});

test("deleteKb 前 evict 缓存连接，文件可删除（Windows 占用回归）", () => {
  const kb = store.createKb({ folderPath: srcDir });
  const conn = openKbDb(dir, kb.id); // 建立缓存
  store.deleteKb(kb.id);
  expect(existsSync(kbDbPath(dir, kb.id))).toBe(false);
  // 旧句柄已被 evict 关闭（Windows 上文件占用随之释放）：再操作明确抛错，不静默读到已删数据
  expect(() => conn.run("SELECT 1")).toThrow();
  // 重复关闭安全：调用方惯用 finally db.close()
  expect(() => conn.close()).not.toThrow();
});

test("缓存命中的库文件被外部删除：openKbDb 丢弃缓存并重建文件（不写已删 inode）", () => {
  const a = openKbDb(dir, "kb_ext_gone");
  const p = kbDbPath(dir, "kb_ext_gone");
  // 外部删掉库文件（连接仍活着：`SELECT 1` 是常量表达式、不碰文件，探活看不出来）
  removeKbFiles("kb_ext_gone");
  expect(existsSync(p)).toBe(false);

  const b = openKbDb(dir, "kb_ext_gone");
  expect(b).not.toBe(a); // 缓存项被丢弃（否则后续写入落在已 unlink 的 inode 上）
  expect(existsSync(p)).toBe(true); // 文件被重建回来
  expect((b.query("SELECT COUNT(*) c FROM chunks").get() as { c: number }).c).toBe(0);
  expect(() => a.close()).not.toThrow();
});

test("索引中途连接被外部 evict：job 行清理、status 不卡 indexing", async () => {
  const kb = store.createKb({ folderPath: srcDir });
  // 最坏形态：嵌入阶段外部关掉连接（并发 deleteKb/evict），此后写库必抛
  const embedFn: EmbedFn = async () => {
    evictKbDb(kb.id);
    throw new Error("模拟连接被外部关闭");
  };
  await expect(runIndex(ctx, kb.id, embedFn)).rejects.toThrow();
  // 失败收尾不能因「连接已关闭」而中断：job 行必须清掉，否则重入防护会把库锁死
  expect(store.getJob(kb.id)).toBeNull();
  expect(store.getKb(kb.id)!.status).toBe("error");
});

test("检索路径：库文件丢失标 skippedKbs(db_missing)，不当作空库返回未找到", async () => {
  const kb = store.createKb({ folderPath: srcDir, name: "丢库" });
  openKbDb(dir, kb.id); // 建库
  // chunkCount>0：跳过「空库静默跳过」分支，才走到 db 文件缺失的判定
  store.updateStatus(kb.id, "ready", { chunkCount: 1 });
  evictKbDb(kb.id);
  removeKbFiles(kb.id);

  // 查询嵌入注入 null：不触发模型，本用例只看库文件缺失的分支
  const r = await searchKnowledge(ctx, [kb.id], "内容甲", {
    limit: 5,
    embedQueryFn: async () => null,
  });
  expect(r.found).toBe(false);
  expect(r.skippedKbs).toContainEqual({ kbId: kb.id, reason: "db_missing" });

  // 库文件回来（重新索引建库）后同一路径照常可检索：缓存的失效不是永久的
  const db = openKbDb(dir, kb.id);
  db.run(
    `INSERT INTO chunks (id, file_path, file_type, title, breadcrumb, start_line, end_line,
       content, prefix_content, content_hash, file_mtime, file_size, embedding, updated_at)
     VALUES ('c1', 'a.md', 'md', 'A', NULL, 1, 3, '内容甲。', '内容甲。', 'h1', 1, 1, NULL, 1)`,
  );
  expect((db.query("SELECT COUNT(*) c FROM chunks").get() as { c: number }).c).toBe(1);
});
