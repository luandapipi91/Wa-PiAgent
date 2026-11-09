// 每库 db 的 sqlite-vector 封装：knowledge 版（表/列固定为 chunks.embedding）。
// 机制仿 memory/vector-ext.ts 但不能直接复用其 init/scan——那边硬编码
// memories.embedding。扩展加载与降级日志直接复用 loadVectorExtension，
// 扩展行为注意点（连接级 init、k 必写、过滤在扫描后）见该文件头部注释。
import type { Database } from "bun:sqlite";
import { loadVectorExtension, SCAN_K, type VectorHit } from "../memory/vector-ext";
import { EMBED_DIM } from "../memory/schema";

const KB_EMBED_TABLE = "chunks";
const KB_EMBED_COLUMN = "embedding";
/** 语义通道的扫描宽度：覆盖过滤损耗（与 memory 同值） */
export const KB_SCAN_K = SCAN_K;

const initialized = new WeakSet<Database>();

/** 声明知识库 chunks 表的向量列。每个新连接都要调一次（连接级上下文）。 */
export function initKbVectorColumn(db: Database): boolean {
  if (initialized.has(db)) return true;
  if (!loadVectorExtension(db)) return false;
  try {
    db.run(
      `SELECT vector_init('${KB_EMBED_TABLE}', '${KB_EMBED_COLUMN}', 'type=FLOAT32,dimension=${EMBED_DIM},distance=COSINE,normalized=1')`,
    );
    initialized.add(db);
    return true;
  } catch (err) {
    console.error("[knowledge] vector_init 失败：", err);
    return false;
  }
}

export function isKbVectorReady(db: Database): boolean {
  return initialized.has(db);
}

/**
 * 重建量化索引并预热到内存（幂等；量化数据覆盖写入 shadow table，不累积）。
 *
 * 「空索引」不是失败：全新库没有向量数据时扩展的 vector_quantize_preload 会抛错，
 * 先用廉价查询判断有无待量化数据——无则无事可做，直接成功返回。
 * （机制与 memory/vector-ext.ts refreshQuantizedIndex 相同。）
 */
export function refreshKbQuantizedIndex(db: Database): boolean {
  if (!initKbVectorColumn(db)) return false;
  try {
    const { n } = db
      .query(`SELECT COUNT(*) AS n FROM ${KB_EMBED_TABLE} WHERE ${KB_EMBED_COLUMN} IS NOT NULL`)
      .get() as { n: number };
    if (n === 0) return true;
    db.run(`SELECT vector_quantize('${KB_EMBED_TABLE}', '${KB_EMBED_COLUMN}')`);
    db.run(`SELECT vector_quantize_preload('${KB_EMBED_TABLE}', '${KB_EMBED_COLUMN}')`);
    return true;
  } catch (err) {
    console.error("[knowledge] 量化索引构建失败：", err);
    return false;
  }
}

/**
 * 量化扫描：返回 KB_SCAN_K 条候选（未做 scope 过滤，过滤由调用方完成）。
 * chunks 主键是 TEXT uuid，JOIN 仍走隐式 rowid（表非 WITHOUT ROWID，两者并存）。
 */
export function kbQuantizedScan(db: Database, queryVec: Uint8Array, k = KB_SCAN_K): VectorHit[] {
  if (!isKbVectorReady(db)) return [];
  try {
    return db
      .query(
        `SELECT c.id AS id, v.distance AS distance
           FROM ${KB_EMBED_TABLE} c
           JOIN vector_quantize_scan('${KB_EMBED_TABLE}', '${KB_EMBED_COLUMN}', ?, ?) v
             ON v.rowid = c.rowid
          WHERE c.embedding IS NOT NULL`,
      )
      .all(queryVec, k) as VectorHit[];
  } catch (err) {
    console.error("[knowledge] 量化扫描失败（本次降级为词法检索）：", err);
    return [];
  }
}
