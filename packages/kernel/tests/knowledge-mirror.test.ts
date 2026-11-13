import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mirrorDirFor,
  mirrorMdPath,
  isMirrorFresh,
  removeMirrorFile,
  readMirrorMd,
} from "../src/knowledge/mirror";
import { KB_SCHEMA_SQL } from "../src/knowledge/schema";
import { KnowledgeStore, type MirrorMeta } from "../src/knowledge/store";

// mirror 目录管理 + mirror_meta/last_snapshot 列测试（任务 7）：
// 路径/新鲜度/删除走真实临时目录；store 层走 :memory: 登记库（与 knowledge-store.test.ts 同款）。

describe("mirror 路径与新鲜度", () => {
  let m: string;
  let waPiDir: string;

  beforeEach(() => {
    waPiDir = mkdtempSync(join(tmpdir(), "kb-mirror-wapidir-"));
    m = mkdtempSync(join(tmpdir(), "kb-mirror-dir-"));
  });
  afterEach(() => {
    rmSync(waPiDir, { recursive: true, force: true });
    rmSync(m, { recursive: true, force: true });
  });

  test("路径计算", () => {
    expect(mirrorMdPath("/d/kb1/mirror", "顾客/顾客列表.docx")).toBe("/d/kb1/mirror/顾客/顾客列表.docx.md");
  });

  test("mirrorDirFor 与 <kbId>.db 同级", () => {
    // 形态：<waPiDir>/knowledge/<kbId>/mirror（kbDbPath 是 <waPiDir>/knowledge/<kbId>.db）
    expect(mirrorDirFor(waPiDir, "kb1")).toBe(join(waPiDir, "knowledge", "kb1", "mirror"));
  });

  test("isMirrorFresh: mtime+size 双条件", () => {
    writeFileSync(join(m, "a.md"), "x");
    const st = statSync(join(m, "a.md"));
    expect(isMirrorFresh(m, "a", st.mtimeMs, st.size)).toBe(true);
    expect(isMirrorFresh(m, "a", st.mtimeMs + 1, st.size)).toBe(false);
    expect(isMirrorFresh(m, "a", st.mtimeMs, st.size + 1)).toBe(false);
    expect(isMirrorFresh(m, "不存在", 0, 0)).toBe(false);
  });

  test("removeMirrorFile 连带 _assets 目录", () => {
    mkdirSync(join(m, "sub"), { recursive: true });
    writeFileSync(join(m, "sub", "a.docx.md"), "x");
    const imgDir = join(m, "_assets", "sub", "a.docx");
    mkdirSync(imgDir, { recursive: true });
    writeFileSync(join(imgDir, "img1.png"), "png");
    removeMirrorFile(m, join("sub", "a.docx"));
    expect(existsSync(join(m, "sub", "a.docx.md"))).toBe(false);
    expect(existsSync(imgDir)).toBe(false);
    // 不存在时幂等：再删一次不抛
    expect(() => removeMirrorFile(m, join("sub", "a.docx"))).not.toThrow();
  });

  test("readMirrorMd: 存在读全文, 不存在返回 null", () => {
    writeFileSync(join(m, "a.md"), "正文甲");
    expect(readMirrorMd(m, "a")).toBe("正文甲");
    expect(readMirrorMd(m, "不存在")).toBeNull();
  });
});

// ===== schema 迁移：knowledge_bases 增 mirror_meta / last_snapshot 两列（旧库打开自动补） =====

describe("schema 迁移", () => {
  test("新库 DDL 直含 mirror_meta 与 last_snapshot 列", () => {
    const db = new Database(":memory:");
    db.run(KB_SCHEMA_SQL);
    const cols = (db.query(`PRAGMA table_info(knowledge_bases)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain("mirror_meta");
    expect(cols).toContain("last_snapshot");
    db.close();
  });

  test("旧库打开自动补列：无 mirror_meta/last_snapshot 的存量 DDL 不报错且补齐", () => {
    // 模拟已发布版本的库结构：两列都还没有
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
    // 打开路径即 KnowledgeStore 构造器：不抛错 + 两列出现
    expect(() => new KnowledgeStore(legacy, "/tmp/wa-pi-test")).not.toThrow();
    const cols = (legacy.query(`PRAGMA table_info(knowledge_bases)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain("mirror_meta");
    expect(cols).toContain("last_snapshot");
    legacy.close();
  });
});

// ===== store 层：mirror_meta JSON 往返 + last_snapshot 持久化 =====

describe("store mirror_meta / last_snapshot", () => {
  let store: KnowledgeStore;
  /** 登记库连接（脏数据用例绕过 store 直接写列） */
  let regDb: Database;
  let kbId: string;

  beforeEach(() => {
    regDb = new Database(":memory:");
    regDb.run(KB_SCHEMA_SQL);
    store = new KnowledgeStore(regDb, "/tmp/wa-pi-test");
    kbId = store.createKb({ folderPath: "/tmp/wa-pi-test-src", name: "a", description: "" }).id;
  });

  test("set/getMirrorMeta 往返", () => {
    expect(store.getMirrorMeta(kbId)).toBeNull(); // 未设置
    const meta: MirrorMeta = { converterVersion: 1, converted: 3, degraded: 1, images: 8 };
    store.setMirrorMeta(kbId, meta);
    expect(store.getMirrorMeta(kbId)).toEqual(meta);
  });

  test("mirror_meta 列里的脏数据（非 JSON）读出为 null", () => {
    store.setMirrorMeta(kbId, { converterVersion: 1, converted: 1, degraded: 0, images: 0 });
    // 绕过 store 直接写坏数据（模拟手改/旧版残留）
    regDb.run(`UPDATE knowledge_bases SET mirror_meta = '{oops' WHERE id = ?`, [kbId]);
    expect(store.getMirrorMeta(kbId)).toBeNull();
  });

  test("last_snapshot 持久化往返（离线变更补偿的基石）", () => {
    expect(store.getLastSnapshot(kbId)).toBeNull(); // 未设置的库返回 null
    store.setLastSnapshot(kbId, "a.txt|123|4");
    expect(store.getLastSnapshot(kbId)).toBe("a.txt|123|4");
  });

  test("mirror_meta / last_snapshot 互不干扰（同一行两列独立读写）", () => {
    store.setMirrorMeta(kbId, { converterVersion: 2, converted: 5, degraded: 0, images: 3 });
    store.setLastSnapshot(kbId, "b.md|9|2");
    expect(store.getMirrorMeta(kbId)).toEqual({ converterVersion: 2, converted: 5, degraded: 0, images: 3 });
    expect(store.getLastSnapshot(kbId)).toBe("b.md|9|2");
  });
});
