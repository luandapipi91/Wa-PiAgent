// 每库独立 db 连接：<WA_PI_DIR>/knowledge/<kbId>.db。
//
// 连接按 kbId 缓存复用：索引与检索共享同一条连接，避免每次打开都重跑 DDL、
// 重做向量列声明（initKbVectorColumn 是连接级操作）。
//
// 连接缓存会让 Windows 上 deleteKb 因文件占用删不掉——因此删库路径必须显式
// `evictKbDb(id)` 先关连接再 unlink；进程退出走 `closeAllKbDbs()`。
// 这里刻意不提供「用完自关」的约定：句柄归缓存所有，调用方关掉别人正在用的
// 连接（索引持有一整轮、期间检索命中同一实例）会把活任务打断。
//
// 缓存项的失效兜底：命中时做一次 `SELECT 1` 探活，抛错即丢弃重建——既有大量
// 调用方（测试的 withKbDb 等）习惯用完即 close，纯缓存会返回已关闭连接。
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";
import { KB_DB_SCHEMA_SQL } from "./schema";
import { kbDbPath } from "./paths";
import { initKbVectorColumn } from "./vector";
import { ensureCustomSqlite } from "../memory/sqlite-library";

// macOS：切换 vanilla SQLite 以启用扩展加载（语义检索前提）。幂等。
// 必须在本模块任何 Database 实例创建前调用；失败静默降级——
// 语义通道关闭、词法照常，与既有降级路径一致。
ensureCustomSqlite();

/** 缓存项：path 一并记下，同名 kbId 换目录（测试）时能识别出不该复用 */
interface CachedKbDb {
  path: string;
  db: Database;
}

const cache = new Map<string, CachedKbDb>();

/** 库文件缺失（检索路径据此区分「必须重建索引」与「库损坏」） */
export class KbDbMissingError extends Error {}

/** 连接是否还活着：close() 过的 bun:sqlite 句柄会在任何查询处抛错 */
function alive(db: Database): boolean {
  try {
    db.query("SELECT 1").get();
    return true;
  } catch {
    return false;
  }
}

/**
 * 取缓存里的活连接；路径不符 / 已失效（被外部关闭）则丢弃该项。
 * 丢弃时静默重建，不向上报错——调用方拿到的必须是一条可用连接。
 */
function cachedAlive(kbId: string, path: string): Database | null {
  const entry = cache.get(kbId);
  if (!entry) return null;
  if (entry.path === path && alive(entry.db)) return entry.db;
  cache.delete(kbId);
  try {
    entry.db.close();
  } catch {
    /* 已关闭/损坏：目标是让缓存里没有它，关闭失败无可补救 */
  }
  return null;
}

/** 建连接 + 初始化 pragma/schema/向量列，成功后入缓存；中途失败关掉半初始化连接再抛 */
function initDb(kbId: string, path: string, create: boolean): Database {
  const db = new Database(path, { create });
  try {
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA busy_timeout = 60000");
    db.run(KB_DB_SCHEMA_SQL);
    // 向量列声明是「连接级」的（扩展要求每个新连接重新 init），量化数据在库内持久化。
    // 失败不阻断打开——检索的词法通道照常，只是没有语义通道。
    initKbVectorColumn(db);
    cache.set(kbId, { path, db });
    return db;
  } catch (err) {
    // 打开中途失败（如文件损坏非 sqlite 库 → SQLITE_NOTADB）：必须关掉半初始化连接，
    // 否则 Windows 上句柄挂着锁死文件/目录（审查修复：与 runIndex 的失败收尾配套）。
    // 失败路径不入缓存：损坏文件下次仍要重新尝试（修好/删掉后即可恢复）
    try {
      db.close();
    } catch {
      /* 已损坏连接的关闭失败无可补救 */
    }
    throw err;
  }
}

/** 打开（必要时新建）某知识库的独立 db；同库复用缓存连接。建库/索引路径用 */
export function openKbDb(waPiDir: string, kbId: string): Database {
  const path = kbDbPath(waPiDir, kbId);
  return cachedAlive(kbId, path) ?? initDb(kbId, path, true);
}

/**
 * 打开「已存在」的某知识库 db；文件不存在时抛错而不是建空库。
 * 检索路径用：库文件被删/丢失时要显式暴露，不能静默当成「空库 → 未找到」。
 */
export function openKbDbExisting(waPiDir: string, kbId: string): Database {
  const path = kbDbPath(waPiDir, kbId);
  if (!existsSync(path)) {
    evictKbDb(kbId); // 文件都没了：缓存里若有活连接，那是别的路径或已删文件的残留
    throw new KbDbMissingError(`知识库 db 不存在：${path}`);
  }
  return cachedAlive(kbId, path) ?? initDb(kbId, path, false);
}

/** 关闭并移除某库的缓存连接（删库前必须调用：Windows 上句柄占用会让文件删不掉） */
export function evictKbDb(kbId: string): void {
  const entry = cache.get(kbId);
  if (!entry) return;
  cache.delete(kbId);
  try {
    entry.db.close();
  } catch {
    /* 已关闭/损坏：目标是「缓存里没有它」，关闭失败不阻断删库 */
  }
}

/** 关闭全部缓存连接（kernel 退出用；测试夹具也用它归位模块级状态） */
export function closeAllKbDbs(): void {
  for (const entry of cache.values()) {
    try {
      entry.db.close();
    } catch {
      /* 已关闭/损坏：退出路径无可补救 */
    }
  }
  cache.clear();
}
