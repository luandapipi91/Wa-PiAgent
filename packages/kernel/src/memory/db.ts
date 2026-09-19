// 记忆库连接管理：<WA_PI_DIR>/memories.db，单库统管 global + project。
// WAL 允许读写并发；busy_timeout 防短暂锁竞争直接报错。
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema";

// 连接缓存：同一进程内同一路径复用连接，避免反复打开 WAL 库与重放建表 SQL。
const cache = new Map<string, Database>();

export function memoryDbPath(waPiDir: string): string {
  return join(waPiDir, "memories.db");
}

/** 打开（必要时新建）记忆库；同一路径重复调用返回同一连接 */
export function openMemoryDb(waPiDir: string): Database {
  const path = memoryDbPath(waPiDir);
  const hit = cache.get(path);
  if (hit) return hit;

  mkdirSync(waPiDir, { recursive: true });
  const db = new Database(path, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA busy_timeout = 5000");
  db.run(SCHEMA_SQL);
  db.run(
    "INSERT INTO schema_meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [SCHEMA_VERSION],
  );
  cache.set(path, db);
  return db;
}

/** 关闭并清空缓存（测试夹具用） */
export function closeAllMemoryDbs(): void {
  for (const db of cache.values()) db.close();
  cache.clear();
}
