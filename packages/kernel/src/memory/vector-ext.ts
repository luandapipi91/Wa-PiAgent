// sqlite-vector 扩展的唯一封装层：其他地方不得直接拼扩展 SQL。
//
// 三个必须知道的扩展行为（实测）：
// 1. vector_init 是「连接级上下文」，每个新连接都要重新调用；量化数据本身持久化在库内，
//    重开后无需重新 vector_quantize（实测：不调 init 直接扫描报 "unable to retrieve context"）。
// 2. 取最近 k 必须写 `k`：省略 k 的流式模式返回 rowid 顺序而非距离顺序，
//    `LIMIT 5` 拿到的不是最近 5 条（实测 0/10 与精确 top-5 一致）。
// 3. 过滤发生在扫描之后：WHERE 条件不会减少扫描量，k 给小了过滤后可能为空。
//    因此扫描 k 取 `SCAN_K`（远大于最终返回条数）再由上游过滤。
import type { Database } from "bun:sqlite";
import { getExtensionPath } from "@sqliteai/sqlite-vector";

import { EMBED_DIM } from "./schema";

export const EMBED_TABLE = "memories";
export const EMBED_COLUMN = "embedding";
export { EMBED_DIM };
/** 语义通道的扫描宽度：覆盖过滤损耗（实测 k=20 时按项目过滤可为 0 条） */
export const SCAN_K = 200;

const loaded = new WeakSet<Database>();
const initialized = new WeakSet<Database>();
let unavailableLogged = false;

/** 加载扩展；失败返回 false 且只记一次日志（后续静默降级） */
export function loadVectorExtension(db: Database): boolean {
  if (loaded.has(db)) return true;
  try {
    db.loadExtension(getExtensionPath());
    // 调用一次以确认函数可用（扩展加载成功但符号缺失时会在此暴露）
    db.query("select vector_version() v").get();
    loaded.add(db);
    return true;
  } catch (err) {
    if (!unavailableLogged) {
      unavailableLogged = true;
      console.error("[memory-semantic] sqlite-vector 扩展加载失败，语义检索将被禁用：", err);
    }
    return false;
  }
}

/** 声明记忆表的向量列。每个连接调用一次即可。 */
export function initVectorColumn(db: Database): boolean {
  if (initialized.has(db)) return true;
  if (!loadVectorExtension(db)) return false;
  try {
    db.run(
      `SELECT vector_init('${EMBED_TABLE}', '${EMBED_COLUMN}', 'type=FLOAT32,dimension=${EMBED_DIM},distance=COSINE,normalized=1')`,
    );
    initialized.add(db);
    return true;
  } catch (err) {
    console.error("[memory-semantic] vector_init 失败：", err);
    return false;
  }
}

export function isVectorReady(db: Database): boolean {
  return initialized.has(db);
}

/** 重建量化索引并预热到内存（幂等；量化数据会覆盖写入 shadow table，不累积） */
export function refreshQuantizedIndex(db: Database): boolean {
  if (!initVectorColumn(db)) return false;
  try {
    db.run(`SELECT vector_quantize('${EMBED_TABLE}', '${EMBED_COLUMN}')`);
    db.run(`SELECT vector_quantize_preload('${EMBED_TABLE}', '${EMBED_COLUMN}')`);
    return true;
  } catch (err) {
    console.error("[memory-semantic] 量化索引构建失败：", err);
    return false;
  }
}

export interface VectorHit {
  id: string;
  distance: number;
}

/** 量化扫描：返回 SCAN_K 条候选（未做 scope 过滤，过滤由调用方完成） */
export function quantizedScan(db: Database, queryVec: Uint8Array, k = SCAN_K): VectorHit[] {
  if (!isVectorReady(db)) return [];
  try {
    return db
      .query(
        `SELECT m.id AS id, v.distance AS distance
           FROM ${EMBED_TABLE} m
           JOIN vector_quantize_scan('${EMBED_TABLE}', '${EMBED_COLUMN}', ?, ?) v
             ON v.rowid = m.rowid
          WHERE m.embedding IS NOT NULL`,
      )
      .all(queryVec, k) as VectorHit[];
  } catch (err) {
    console.error("[memory-semantic] 量化扫描失败（本次降级为词法检索）：", err);
    return [];
  }
}
