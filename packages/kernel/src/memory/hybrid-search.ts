// 混合检索：词法（BM25 通道） + 语义（向量通道）用 RRF 融合。
//
// 为什么用 RRF 而不是加权求和：BM25 分数与向量距离量纲完全不同，
// 加权求和需要针对语料调参；RRF 只看名次（rank），无需归一化、对分数尺度免疫。
//
// 降级策略：任何一步（扩展不可用 / 模型不可用 / 查询向量为空 / 编码或扫描抛错 /
// 语义侧回读或融合抛错）都退回纯词法结果，绝不因语义通道故障让 memory_search 失败。
import type { MemoryDao, SearchHit, SearchOpts } from "./dao";
import { embedQuery } from "./embedder";
import { isVectorReady, quantizedScan } from "./vector-ext";

/** RRF 平滑常数：60 是论文推荐值，越大越削弱头部名次的优势 */
export const RRF_K = 60;
/** 每个通道取多少条参与融合 */
export const CHANNEL_TOP_N = 50;

export interface FusedItem<T> {
  item: T;
  score: number;
}

/** Reciprocal Rank Fusion：score = Σ 1/(K + rank)，rank 从 1 开始 */
export function fuseRrf<T>(channels: T[][], idOf: (x: T) => string, k = RRF_K): FusedItem<T>[] {
  const scores = new Map<string, number>();
  const kept = new Map<string, T>();
  for (const channel of channels) {
    channel.forEach((item, idx) => {
      const id = idOf(item);
      if (!kept.has(id)) kept.set(id, item);
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + idx + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ item: kept.get(id)!, score }))
    .sort((a, b) => b.score - a.score);
}

export interface HybridSearchOptions extends SearchOpts {
  limit?: number;
}

export interface HybridSearchHit extends SearchHit {
  /** 命中的通道，便于调试与后续调参 */
  channels: Array<"lexical" | "semantic">;
}

/**
 * 把融合分数按首位归一到 (0, 1]，使最相关条目为 1。入参必须已按 score 降序
 * （fuseRrf 保证）。
 *
 * 为什么必须归一化：RRF 分值只表达「名次」，量级很小且随命中通道数变化
 * （单通道首位 1/(K+1)≈0.0164，双通道首位 2/(K+1)≈0.0328），而 `memory_search`
 * 把 score 原样吐给展示 / 阈值 / 评测侧 —— 这些消费方是按旧 `dao.search` 的
 * 「0–1 加权和」量纲写的。不归一化，同一字段在接线前后是两套数字
 * （阈值恒不过、展示恒为 0）。
 */
export function normalizeScores<T extends { score: number }>(hits: T[]): T[] {
  const top = hits.length > 0 ? hits[0].score : 0;
  if (!(top > 0)) return hits; // 空集 / 非正首位分数（理论不可达）：原样返回，不产生 NaN
  return hits.map((h) => ({ ...h, score: h.score / top }));
}

/**
 * 混合检索入口。签名是 async 的（需要 await 查询向量），
 * 但 memory_search 工具侧的同步契约不变——工具层改为 await 本函数。
 */
export async function searchHybrid(
  dao: MemoryDao,
  rawQuery: string,
  opts: HybridSearchOptions = {},
): Promise<HybridSearchHit[]> {
  const limit = opts.limit ?? 10;
  const lexical = dao.search(rawQuery, { ...opts, limit: CHANNEL_TOP_N }) as SearchHit[];
  const lexicalOnly = (): HybridSearchHit[] =>
    lexical.slice(0, limit).map((h) => ({ ...h, channels: ["lexical"] }));

  // 语义侧装配——取查询向量 → 量化扫描 → scope 过滤 → 按 id 回读 → RRF 融合——
  // 整体收在同一个兜底之下。只包住 embedQuery + quantizedScan 是不够的：回读
  // (getByIds) 与融合发生在扫描之后，同样会抛（库被占用 / 损坏，或将来 SCAN_K
  // 调大到撞上 SQLite 的 `too many SQL variables`）。任何一步抛错都退回纯词法，
  // 绝不让 memory_search 失败。
  try {
    let semanticIds: string[] = [];
    if (isVectorReady(dao.db)) {
      // 查询侧编码可能抛错（推理期原生绑定异常等，embedder 的加载期 catch 覆盖不到）。
      const qv = await embedQuery(rawQuery);
      if (qv) {
        // 扫描宽度 SCAN_K 远大于最终返回条数：过滤发生在扫描之后，
        // 且 scope 收窄（global + 当前项目）会进一步削减候选。
        semanticIds = quantizedScan(dao.db, qv)
          .filter((hit) => dao.matchesScope(hit.id, opts))
          .map((hit) => hit.id);
      }
    }

    if (semanticIds.length === 0) return lexicalOnly();

    const semanticRows = dao.getByIds(semanticIds);
    const fused = fuseRrf<{ id: string }>(
      [lexical.map((h) => ({ id: h.id })), semanticIds.map((id) => ({ id }))],
      (x) => x.id,
    );

    const byId = new Map<string, SearchHit>();
    for (const h of lexical) byId.set(h.id, h);
    for (const r of semanticRows) {
      if (!byId.has(r.id)) {
        byId.set(r.id, { ...r, score: 0, snippet: dao.snippetFor(r, rawQuery) });
      }
    }

    return normalizeScores(
      fused
        .filter((f) => byId.has(f.item.id))
        .slice(0, limit)
        .map((f) => {
          const row = byId.get(f.item.id)!;
          const channels: Array<"lexical" | "semantic"> = [];
          if (lexical.some((h) => h.id === f.item.id)) channels.push("lexical");
          if (semanticIds.includes(f.item.id)) channels.push("semantic");
          return { ...row, score: f.score, channels };
        }),
    );
  } catch (err) {
    console.error("[memory-semantic] 语义通道失败（本次降级为词法检索）：", err);
    return lexicalOnly();
  }
}
