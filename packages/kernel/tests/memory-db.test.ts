import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openMemoryDb, memoryDbPath, closeAllMemoryDbs } from "../src/memory/db";
import { projectNameFromCwd } from "../src/memory/paths";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mem-db-")); });
// 连接缓存是模块级的：每个用例的临时目录都不同，不清理会让连接随用例数累积到进程结束
afterEach(() => { closeAllMemoryDbs(); rmSync(dir, { recursive: true, force: true }); });

test("建库落在 <waPiDir>/memories.db 且建出三张表", () => {
  const db = openMemoryDb(dir);
  expect(existsSync(memoryDbPath(dir))).toBe(true);
  const names = db
    .query("SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name")
    .all()
    .map((r: any) => r.name);
  expect(names).toContain("memories");
  expect(names).toContain("memories_fts");
  expect(names).toContain("schema_meta");
  expect(names).toContain("idx_mem_layer");
});

test("重复打开返回同一连接（缓存）", () => {
  expect(openMemoryDb(dir)).toBe(openMemoryDb(dir));
});

test("WAL 已开启且 schema 版本已写入", () => {
  const db = openMemoryDb(dir);
  expect((db.query("PRAGMA journal_mode").get() as any).journal_mode).toBe("wal");
  const v = db.query("SELECT value FROM schema_meta WHERE key='schema_version'").get();
  expect(v).not.toBeNull();
});

test("projectNameFromCwd 取 basename 并净化非法字符", () => {
  expect(projectNameFromCwd("/Users/co/repos/my-app")).toBe("my-app");
  expect(projectNameFromCwd("/Users/co/repos/my-app/")).toBe("my-app");
  // 盘根 cwd（源码 "H:\\"，运行时 `H:\`）→ "H"
  expect(projectNameFromCwd("H:\\")).toBe("H");
  expect(projectNameFromCwd("/")).toBe("default");
});
