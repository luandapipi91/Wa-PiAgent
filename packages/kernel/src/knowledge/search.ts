// 知识库混合检索：每库双路召回（FTS BM25 词法 + 量化扫描语义）→ 库内 RRF 融合 →
// 跨库按融合分合并截断。给任务 8 的 knowledge_search 工具供能。
//
// RRF 常量与距离门的取值照抄 memory/hybrid-search.ts（不 import——那边与 memory
// 的 dao 类型耦合）；融合逻辑参照其 fuseRrf 写法（score = Σ 1/(K + rank)，只看
// 名次、对分数尺度免疫）。RRF 原始分跨库可比（都是名次的调和和），且 knowledge
// 检索没有 memory_search 的 0–1 量纲历史包袱，故不做首位归一化。
import { buildMatchExpr } from "../memory/query";
import { embedQuery, embedFingerprint } from "../memory/embedder";
import type { KbContext } from "./index";
import { openKbDb } from "./kb-db";
import { kbQuantizedScan, KB_SCAN_K } from "./vector";

/** RRF 平滑常数：60 是论文推荐值，越大越削弱头部名次的优势（照抄 memory 取值） */
export const RRF_K = 60;
/** 每个通道取多少条参与融合（照抄 memory 取值） */
export const CHANNEL_TOP_N = 50;
/** 语义候选相关度门槛：量化距离 ≤ 阈值放行（照抄 memory 取值；bge 实测落在相关/无关分布间隙上） */
export const SEMANTIC_MAX_DISTANCE = 0.75;

/** 语义候选相关度判定：距离 ≤ 阈值（即相似度足够）才进 RRF 融合 */
export function withinSemanticDistance(distance: number): boolean {
  return distance <= SEMANTIC_MAX_DISTANCE;
}

export interface KbSearchHit {
  kbId: string;
  kbName: string;
  content: string;
  filePath: string;
  title: string | null;
  breadcrumb: string | null;
  startLine: number | null;
  endLine: number | null;
  score: number;
}

/** skippedKbs 条目：reason 取 not_ready（status≠ready）/ embed_meta_mismatch（向量通道降级）/ missing（库不存在） */
export interface KbSkippedKb {
  kbId: string;
  reason: string;
}

export interface KbSearchResult {
  /** 全库零命中为 false——不许低分凑数 */
  found: boolean;
  results: KbSearchHit[];
  skippedKbs: KbSkippedKb[];
}

/** 查询嵌入函数形状：缺省用真实 embedQuery，测试注入 fake 绕开模型（同 indexer 的 EmbedFn 模式） */
export type QueryEmbedFn = (text: string) => Promise<Uint8Array | null>;

/**
 * 跨库混合检索。kbIds 顺序执行（SQLite 毫秒级操作，并发无收益还要管理连接生命周期）；
 * 查询嵌入与查询词 bigram 全流程各只算一次（跨库复用）。
 */
export async function searchKnowledge(
  ctx: KbContext,
  kbIds: string[],
  query: string,
  limit: number,
  embedQueryFn: QueryEmbedFn = embedQuery,
): Promise<KbSearchResult> {
  const skippedKbs: KbSkippedKb[] = [];
  const merged: KbSearchHit[] = [];

  // 查询侧只算一次：嵌入（null = 模型不可用 → 语义通道禁用）+ FTS MATCH 表达式
  const queryVec = await embedQueryFn(query);
  const matchExpr = buildMatchExpr(query);

  for (const kbId of kbIds) {
    const kb = ctx.store.getKb(kbId);
    if (!kb) {
      skippedKbs.push({ kbId, reason: "missing" });
      continue;
    }
    if (kb.status !== "ready") {
      skippedKbs.push({ kbId, reason: "not_ready" });
      continue;
    }

    // 库级指纹直读登记库（KbInfo 投影不含 embed_meta）：null = 从未索引，不算不匹配。
    // 不匹配只降级向量通道（存量向量全部过期），词法照常，仍参与检索。
    const storedMeta = ctx.store.getEmbedMeta(kbId);
    const mismatch = storedMeta !== null && storedMeta !== embedFingerprint();
    if (mismatch) skippedKbs.push({ kbId, reason: "embed_meta_mismatch" });

    const db = openKbDb(ctx.waPiDir, kbId);
    try {
      // 词法通道：FTS MATCH bigram 查询（body 写入侧已 bigram 化），bm25 负值越小越
      // 相关，升序即名次；名次只取决于 SQL 返回顺序，bm25 分值本身不参与融合。
      const lexical = matchExpr
        ? (db
            .query(
              `SELECT c.id AS id
                 FROM chunks_fts
                 JOIN chunks c ON c.id = chunks_fts.chunk_id
                WHERE chunks_fts MATCH ?
                ORDER BY bm25(chunks_fts)
                LIMIT ${CHANNEL_TOP_N}`,
            )
            .all(matchExpr) as Array<{ id: string }>)
        : [];
      // 语义通道：量化扫描（扫描宽度远大于融合条数）→ 距离门过滤；
      // 指纹不匹配或查询向量缺失时整通道跳过（扫描失败扩展内部降级为空数组）。
      const semantic =
        queryVec && !mismatch
          ? kbQuantizedScan(db, queryVec, KB_SCAN_K).filter((h) => withinSemanticDistance(h.distance))
          : [];

      // 库内 RRF 融合：score = Σ 1/(K + rank)，rank 从 1 开始
      const scores = new Map<string, number>();
      for (const channel of [lexical.map((r) => r.id), semantic.map((h) => h.id)]) {
        channel.forEach((id, idx) => {
          scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + idx + 1));
        });
      }
      if (scores.size === 0) continue;
      const fused = [...scores.entries()].sort((a, b) => b[1] - a[1]);

      // 按融合名次回读出处字段（id 来自库内，缺失即跳过的防御不必要——IN 查询必命中）
      const placeholders = fused.map(() => "?").join(",");
      const rows = db
        .query(
          `SELECT id, content, file_path, title, breadcrumb, start_line, end_line
             FROM chunks WHERE id IN (${placeholders})`,
        )
        .all(...fused.map(([id]) => id)) as Array<{
        id: string;
        content: string;
        file_path: string;
        title: string | null;
        breadcrumb: string | null;
        start_line: number | null;
        end_line: number | null;
      }>;
      const byId = new Map(rows.map((r) => [r.id, r]));
      for (const [id, score] of fused) {
        const row = byId.get(id);
        if (!row) continue;
        merged.push({
          kbId,
          kbName: kb.name,
          content: row.content,
          filePath: row.file_path,
          title: row.title,
          breadcrumb: row.breadcrumb,
          startLine: row.start_line,
          endLine: row.end_line,
          score,
        });
      }
    } finally {
      db.close();
    }
  }

  // 跨库合并：按融合分降序截 limit（limit≤0 时 slice 语义不安全，钳到 0）
  merged.sort((a, b) => b.score - a.score);
  const results = merged.slice(0, Math.max(0, limit));
  return { found: results.length > 0, results, skippedKbs };
}
