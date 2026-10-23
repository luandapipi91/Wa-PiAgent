// schema v3 迁移：memories 增加 embedding / embed_meta 两列，page_size 提升到 16K。
//
// 测试分两类：
//   1. :memory: 库 —— 验证版本号、全新库建表形态、存量 v2 库补列且不动数据、幂等；
//   2. 文件库 —— 迁移里的 page_size 重建对内存库是显式跳过的，
//      核心决策（page_size → 16384）只能在文件库上验证（占位：见 migrateToV3 的注释）。
//      文件库用例必须复刻生产配置：openMemoryDb 在跑迁移前就把库设成 WAL，
//      而 WAL 下 `PRAGMA page_size` + `VACUUM` 不生效——不设 WAL 的断言是假绿。
import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_SQL, SCHEMA_VERSION } from "../src/memory/schema";
import { migrateMemoryDb } from "../src/memory/migrations";
import { openMemoryDb, memoryDbPath, closeAllMemoryDbs } from "../src/memory/db";

/** v2 形态的 memories 表（无 embedding / embed_meta），用于造存量库 */
const V2_MEMORIES_SQL = `
  CREATE TABLE memories (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, target TEXT NOT NULL,
    scope TEXT NOT NULL, project_id TEXT, content TEXT NOT NULL,
    title TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '', source TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    last_used_at INTEGER, use_count INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0, archived_at INTEGER
  );
  CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO schema_meta(key, value) VALUES ('schema_version', '2');
  INSERT INTO memories(id, kind, target, scope, content, title, source, created_at, updated_at)
    VALUES ('m1','knowledge','memory','project','项目用 bun','项目用 bun','agent',1,1);
`;

function columnNames(db: Database): string[] {
  return (db.query("PRAGMA table_info(memories)").all() as Array<{ name: string }>).map((c) => c.name);
}

function schemaVersion(db: Database): string {
  const row = db.query("SELECT value FROM schema_meta WHERE key='schema_version'").get() as { value: string };
  return row.value;
}

function pageSize(db: Database): number {
  const row = db.query("PRAGMA page_size").get() as { page_size: number };
  return row.page_size;
}

function journalMode(db: Database): string {
  const row = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
  return row.journal_mode;
}

test("SCHEMA_VERSION 已升到 3", () => {
  expect(SCHEMA_VERSION).toBe("3");
});

test("全新库建表即含 embedding / embed_meta 列", () => {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  const cols = columnNames(db);
  expect(cols).toContain("embedding");
  expect(cols).toContain("embed_meta");
  db.close();
});

test("存量 v2 库迁移到 v3：补列且不动数据", () => {
  const db = new Database(":memory:");
  // 造一个 v2 形态的库（无 embedding 列，版本号 2）
  db.run(V2_MEMORIES_SQL);

  migrateMemoryDb(db);

  const cols = columnNames(db);
  expect(cols).toContain("embedding");
  expect(cols).toContain("embed_meta");
  const row = db.query("SELECT content, embedding, embed_meta FROM memories WHERE id='m1'").get() as {
    content: string;
    embedding: Uint8Array | null;
    embed_meta: string | null;
  };
  expect(row.content).toBe("项目用 bun");
  expect(row.embedding).toBeNull();
  expect(row.embed_meta).toBeNull();
  expect(schemaVersion(db)).toBe("3");
  db.close();
});

test("迁移幂等：重复调用不报错", () => {
  const db = new Database(":memory:");
  db.run(SCHEMA_SQL);
  migrateMemoryDb(db);
  expect(() => migrateMemoryDb(db)).not.toThrow();
  db.close();
});

test("文件库迁移到 v3：WAL 形态下补列、版本号变 3、page_size 重建为 16384", () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-pi-mem-v3-"));
  const file = join(dir, "memories.db");
  const backup = `${file}.pre-v3.bak`;
  const db = new Database(file, { create: true });
  try {
    // 复刻生产配置：openMemoryDb 在迁移前就开了 WAL，测试也必须开着，否则断言不成立
    db.run("PRAGMA journal_mode = WAL");
    db.run(V2_MEMORIES_SQL);
    // 先确认起点真的是小页库，否则「迁移后是 16384」可能只是因为本来就是 16384
    expect(pageSize(db)).toBe(4096);

    migrateMemoryDb(db);

    const cols = columnNames(db);
    expect(cols).toContain("embedding");
    expect(cols).toContain("embed_meta");
    const row = db.query("SELECT content FROM memories WHERE id='m1'").get() as { content: string };
    expect(row.content).toBe("项目用 bun");
    expect(schemaVersion(db)).toBe("3");
    // page_size 只在 VACUUM 时生效，必须真有重建才算迁移到位
    expect(pageSize(db)).toBe(16384);
    // 迁移只为 VACUUM 临时切出 WAL，结束后必须切回（生产依赖 WAL 的读写并发）
    expect(journalMode(db)).toBe("wal");
    // 重建是全库重写，迁移前应留下自包含备份
    expect(existsSync(backup)).toBe(true);

    // 幂等：页大小已达标时不重跑 VACUUM、页大小不变。
    // 把版本号退回 2 并删掉备份，再迁一次——若仍会 VACUUM，备份会被重新写出。
    db.run("UPDATE schema_meta SET value = '2' WHERE key = 'schema_version'");
    rmSync(backup, { force: true });
    migrateMemoryDb(db);
    expect(schemaVersion(db)).toBe("3");
    expect(pageSize(db)).toBe(16384);
    expect(journalMode(db)).toBe("wal");
    expect(existsSync(backup)).toBe(false);
  } finally {
    db.close();
    // 迁移会生成 <db>.pre-v3.bak，一并清掉，别留在 tmp 里
    rmSync(dir, { recursive: true, force: true });
  }
});

test("生产入口 openMemoryDb：WAL 存量库迁移后 page_size 16384，重开仍 16384 且仍是 WAL", () => {
  const dir = mkdtempSync(join(tmpdir(), "wa-pi-mem-v3-entry-"));
  const file = memoryDbPath(dir);
  try {
    // 造 WAL 形态的存量 v2 库（复刻生产：先开 WAL，再落数据）
    const raw = new Database(file, { create: true });
    raw.run("PRAGMA journal_mode = WAL");
    raw.run(V2_MEMORIES_SQL);
    expect(pageSize(raw)).toBe(4096);
    raw.close();

    const db = openMemoryDb(dir);
    expect(pageSize(db)).toBe(16384);
    expect(journalMode(db)).toBe("wal");
    expect(schemaVersion(db)).toBe("3");

    // 重开（清掉连接缓存）后页大小与日志模式必须仍是迁移后的形态
    closeAllMemoryDbs();
    const reopened = openMemoryDb(dir);
    expect(pageSize(reopened)).toBe(16384);
    expect(journalMode(reopened)).toBe("wal");
    expect(schemaVersion(reopened)).toBe("3");
  } finally {
    closeAllMemoryDbs();
    rmSync(dir, { recursive: true, force: true });
  }
});
