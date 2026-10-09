// 记忆库连接管理：<WA_PI_DIR>/memories.db，单库统管 global + project。
// WAL 允许读写并发；busy_timeout 防短暂锁竞争直接报错。
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { SCHEMA_SQL } from "./schema";
import { migrateMemoryDb } from "./migrations";
import { initVectorColumn } from "./vector-ext";
import { ensureCustomSqlite } from "./sqlite-library";

// macOS：切换 vanilla SQLite 以启用扩展加载（语义检索前提）。
// 必须在本模块任何 Database 实例创建前调用；失败（无 dylib / 非 macOS）静默降级——
// 语义通道关闭、词法照常，与既有降级路径一致。
ensureCustomSqlite();

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
  // 结构迁移（内含写 schema_version）：必须在建表后、任何读取前执行，
  // 且不能先写版本号——否则存量库的旧版本号会被覆盖、迁移被跳过。
  migrateMemoryDb(db);
  // 向量列声明是「连接级」的（扩展要求每个新连接重新 init），但量化数据在库内持久化，
  // 不需要重新 vector_quantize。失败不阻断打开——记忆功能整体仍可用，只是没有语义通道。
  initVectorColumn(db);
  cache.set(path, db);
  return db;
}

/** 关闭并清空缓存（测试夹具用） */
export function closeAllMemoryDbs(): void {
  for (const db of cache.values()) db.close();
  cache.clear();
}
