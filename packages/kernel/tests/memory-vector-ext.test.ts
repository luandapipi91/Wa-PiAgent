import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "../src/memory/schema";
import { openMemoryDb, closeAllMemoryDbs } from "../src/memory/db";
import {
  loadVectorExtension,
  initVectorColumn,
  refreshQuantizedIndex,
  quantizedScan,
  isVectorReady,
} from "../src/memory/vector-ext";

/** 静音并捕获 console.error：断言降级日志，同时不让预期内的报错刷屏 */
function captureConsoleError<T>(fn: () => T): { value: T; logged: string } {
  const orig = console.error;
  let logged = "";
  console.error = (...args: unknown[]) => {
    logged += args.map((a) => String(a)).join(" ");
  };
  try {
    return { value: fn(), logged };
  } finally {
    console.error = orig;
  }
}

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  db.run(SCHEMA_SQL);
});

test("扩展可加载并报告版本", () => {
  expect(loadVectorExtension(db)).toBe(true);
  const v = db.query("select vector_version() v").get() as { v: string };
  expect(v.v).toMatch(/^\d+\.\d+\.\d+/);
});

test("initVectorColumn 在已有 memories 表上成功", () => {
  loadVectorExtension(db);
  expect(initVectorColumn(db)).toBe(true);
  expect(isVectorReady(db)).toBe(true);
});

test("写入 embedding 后可被量化扫描命中", () => {
  loadVectorExtension(db);
  initVectorColumn(db);
  const vec = new Uint8Array(new Float32Array(512).fill(0.1).buffer);
  db.run(
    "INSERT INTO memories(id, kind, target, scope, content, title, source, created_at, updated_at, embedding)" +
      " VALUES ('m1','knowledge','memory','project','发版流程','发版流程','agent',1,1,?)",
    [vec],
  );
  refreshQuantizedIndex(db);
  const hits = quantizedScan(db, vec, 5);
  expect(hits.map((h) => h.id)).toContain("m1");
});

test("未初始化时 isVectorReady 为 false，且扫描返回空而不抛错", () => {
  const fresh = new Database(":memory:");
  fresh.run(SCHEMA_SQL);
  expect(isVectorReady(fresh)).toBe(false);
  expect(quantizedScan(fresh, new Uint8Array(512 * 4), 5)).toEqual([]);
  fresh.close();
});

// 空索引不是失败：全新库（没有任何向量数据）上 refreshQuantizedIndex 直接成功返回且不报错。
// 扩展的 preload 在这时会抛「Ensure that vector_quantize() has been called」，但它属于
// 「无数据、无事可做」，不能固化成失败契约（否则全新安装的用户每次启动都会看到 error 日志）。
// 断言方式：既断言返回 true，也用捕获 console.error 断言没有产生任何 [memory-semantic] 日志。
test("空库上 refreshQuantizedIndex 返回 true 且不产生 error 日志", () => {
  const empty = new Database(":memory:");
  empty.run(SCHEMA_SQL);
  const first = captureConsoleError(() => refreshQuantizedIndex(empty));
  expect(first.value).toBe(true);
  expect(first.logged).not.toContain("[memory-semantic]");
  // 重复调用仍为幂等成功（空库语义下不再是失败）
  const again = captureConsoleError(() => refreshQuantizedIndex(empty));
  expect(again.value).toBe(true);
  expect(again.logged).not.toContain("[memory-semantic]");
  empty.close();
});

// 扩展加载失败（缺二进制 / 符号缺失）必须静默降级：不抛错、返回 false。
test("扩展加载失败时只降级不抛错", () => {
  const broken = {
    loadExtension() {
      throw new Error("boom: 扩展缺失");
    },
  } as unknown as Database;
  const { value } = captureConsoleError(() => loadVectorExtension(broken));
  expect(value).toBe(false);
  expect(loadVectorExtension(broken)).toBe(false);
});

// 接线验证：openMemoryDb 内已调用 initVectorColumn，且真实文件库上量化扫描可用。
test("openMemoryDb 打开后向量通道已就绪且能扫描命中", () => {
  const dir = mkdtempSync(join(tmpdir(), "mem-vec-wire-"));
  try {
    const live = openMemoryDb(dir);
    expect(isVectorReady(live)).toBe(true);
    const vec = new Uint8Array(new Float32Array(512).fill(0.25).buffer);
    live.run(
      "INSERT INTO memories(id, kind, target, scope, content, title, source, created_at, updated_at, embedding)" +
        " VALUES ('wire1','knowledge','memory','project','接线验证','接线验证','agent',1,1,?)",
      [vec],
    );
    expect(refreshQuantizedIndex(live)).toBe(true);
    expect(quantizedScan(live, vec, 5).map((h) => h.id)).toContain("wire1");
  } finally {
    closeAllMemoryDbs();
    rmSync(dir, { recursive: true, force: true });
  }
});
