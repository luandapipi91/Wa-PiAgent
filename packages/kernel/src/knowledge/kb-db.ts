// 每库独立 db 连接：<WA_PI_DIR>/knowledge/<kbId>.db。
// 不做连接缓存——每库 db 的打开是毫秒级操作，而缓存连接会让 Windows 上
// deleteKb 因文件占用删不掉（watcher/indexer 持有句柄），调用方用完自关。
import { Database } from "bun:sqlite";
import { KB_DB_SCHEMA_SQL } from "./schema";
import { kbDbPath } from "./paths";
import { initKbVectorColumn } from "./vector";
import { ensureCustomSqlite } from "../memory/sqlite-library";

// macOS：切换 vanilla SQLite 以启用扩展加载（语义检索前提）。幂等。
// 必须在本模块任何 Database 实例创建前调用；失败静默降级——
// 语义通道关闭、词法照常，与既有降级路径一致。
ensureCustomSqlite();

/** 打开（必要时新建）某知识库的独立 db；每次返回新连接 */
export function openKbDb(waPiDir: string, kbId: string): Database {
  const db = new Database(kbDbPath(waPiDir, kbId), { create: true });
  try {
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA busy_timeout = 60000");
    db.run(KB_DB_SCHEMA_SQL);
    // 向量列声明是「连接级」的（扩展要求每个新连接重新 init），量化数据在库内持久化。
    // 失败不阻断打开——检索的词法通道照常，只是没有语义通道。
    initKbVectorColumn(db);
    return db;
  } catch (err) {
    // 打开中途失败（如文件损坏非 sqlite 库 → SQLITE_NOTADB）：必须关掉半初始化连接，
    // 否则 Windows 上句柄挂着锁死文件/目录（审查修复：与 runIndex 的失败收尾配套）
    try {
      db.close();
    } catch {
      /* 已损坏连接的关闭失败无可补救 */
    }
    throw err;
  }
}
