// 知识库混合检索：每库双路召回（FTS BM25 词法 + 量化扫描语义）→ 库内 RRF 融合 →
// 跨库按融合分合并截断。给任务 8 的 knowledge_search 工具供能。
//
// RRF 常量与距离门的取值照抄 memory/hybrid-search.ts（不 import——那边与 memory
// 的 dao 类型耦合）；融合逻辑参照其 fuseRrf 写法（score = Σ 1/(K + rank)，只看
// 名次、对分数尺度免疫）。RRF 原始分跨库可比（都是名次的调和和），且 knowledge
// 检索没有 memory_search 的 0–1 量纲历史包袱，故不做首位归一化。
import type { Database } from "bun:sqlite";
import { stat as fsStat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { buildMatchExpr } from "../memory/query";
import { weightedScoreFusion } from "./search/fusion";
import { MIN_HYBRID_SCORE, hasEnoughLexicalEvidence, queryTokensOf } from "./search/ranking";
import { bigram } from "../memory/bigram";
import { embedQuery } from "../memory/embedder";
import { knowledgeFingerprint } from "./fingerprint";
import type { KbContext } from "./index";
import { KbDbMissingError, openKbDbExisting } from "./kb-db";
import { kbQuantizedScan, KB_SCAN_K } from "./vector";

/** 每个通道取多少条参与融合（照抄 memory 取值） */
export const CHANNEL_TOP_N = 50;
/** 语义候选相关度门槛：量化距离 ≤ 阈值放行（照抄 memory 取值；bge 实测落在相关/无关分布间隙上） */
export const SEMANTIC_MAX_DISTANCE = 0.75;

/** 语义候选相关度判定：距离 ≤ 阈值（即相似度足够）才进 RRF 融合 */
export function withinSemanticDistance(distance: number): boolean {
  return distance <= SEMANTIC_MAX_DISTANCE;
}

/**
 * OR 降级表达式：`"t1" OR "t2" …`。
 * buildMatchExpr 产出的空格分隔短语在 FTS5 里是隐式 AND——中文长问句切成多个 bigram 后
 * 要求同一块全部命中，只有原文子串才满足。零命中时降级 OR 保证「部分重叠」也能召回。
 */
function buildOrMatchExpr(raw: string): string | null {
  const tokens = bigram(raw).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens.map(t => `"${t.replace(/"/g, '""')}"`).join(" OR ");
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
  /** 结果可能落后于磁盘：库更新失败（整库旧索引）或该块的源文件 mtime 已与索引记录不符
   * （抽取失败/外删/索引后被改）——内容可能过期 */
  stale?: boolean;
}

/** skippedKbs 条目：reason 取 not_ready（status≠ready）/ embed_meta_mismatch（向量通道降级）/
 * missing（登记行不存在）/ db_missing（库文件丢失，需重建索引）/ db_error（库文件打不开，如损坏） */
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

/** 源文件 stat 函数形状：缺省真 fs，测试注入计数/伪造实现（同 embedQueryFn 的注入先例） */
export type StatFn = (path: string) => Promise<{ mtimeMs: number }>;

/** searchKnowledge 可注入项（生产调用方不用传） */
export interface SearchOptions {
  statFn?: StatFn;
}

/**
 * 命中块的源文件是否已落后于索引记录。返回 true 的三种情形：
 * 1. 块路径解析后越出库根（file_path 是绝对路径或含 `..`）——不 stat，直接判陈旧；
 * 2. 文件不存在 / stat 报错；
 * 3. mtime 与索引记录不严格相等（SQLite 对分数值存 REAL、往返严格相等，无需容差）。
 * 「无法证明新鲜即陈旧」。
 */
async function sourceChanged(
  root: string,
  filePath: string,
  recordedMtime: number,
  statFn: StatFn,
): Promise<boolean> {
  const rootAbs = resolve(root);
  const abs = resolve(rootAbs, filePath);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + sep)) return true;
  try {
    const st = await statFn(abs);
    return Number(recordedMtime) !== st.mtimeMs;
  } catch {
    return true;
  }
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
  opts: SearchOptions = {},
): Promise<KbSearchResult> {
  const statFn: StatFn = opts.statFn ?? fsStat;
  const skippedKbs: KbSkippedKb[] = [];
  // 中间态多带库根与记录 mtime：截断后要拿它们核对源文件新鲜度（不暴露给调用方）
  const merged: Array<{ hit: KbSearchHit; root: string; recordedMtime: number }> = [];

  // 查询侧只算一次：嵌入（null = 模型不可用 → 语义通道禁用）+ FTS MATCH 表达式
  const queryVec = await embedQueryFn(query);
  const matchExpr = buildMatchExpr(query);
  const queryTokens = queryTokensOf(query);

  for (const kbId of kbIds) {
    const kb = ctx.store.getKb(kbId);
    if (!kb) {
      skippedKbs.push({ kbId, reason: "missing" });
      continue;
    }
    // 更新失败（status=error）但库里仍有上一轮建成的索引：旧数据不是「不可用」，
    // 而是「可能过期」——允许检索并逐条标 stale，比整库下线更符合「旧索引保持可用」的语义
    const staleKb = kb.status === "error" && kb.chunkCount > 0 && kb.lastIndexedAt !== null;
    if (kb.status !== "ready" && !staleKb) {
      skippedKbs.push({ kbId, reason: "not_ready" });
      continue;
    }

    // 库级指纹直读登记库（KbInfo 投影不含 embed_meta）：null = 从未索引，不算不匹配。
    // 不匹配只降级向量通道（存量向量全部过期），词法照常，仍参与检索。
    const storedMeta = ctx.store.getEmbedMeta(kbId);
    const mismatch = storedMeta !== null && storedMeta !== knowledgeFingerprint();
    if (mismatch) skippedKbs.push({ kbId, reason: "embed_meta_mismatch" });

    // 检索路径用「只开已存在的库」：库文件丢失时必须显式报出（skippedKbs），
    // 否则 openKbDb 会当场建一个空库 → 检索恒零命中，用户看到的是「库里没这内容」
    let db: Database;
    try {
      db = openKbDbExisting(ctx.waPiDir, kbId);
    } catch (err) {
      if (err instanceof KbDbMissingError) {
        skippedKbs.push({ kbId, reason: "db_missing" });
      } else {
        // 库在但打不开（如文件损坏）：同样标跳过，不让单库故障拖垮整次跨库检索
        console.warn(`[knowledge] 知识库 db 打开失败 (kbId=${kbId}):`, err);
        skippedKbs.push({ kbId, reason: "db_error" });
      }
      continue;
    }
    // 连接归 kb-db 缓存所有，这里不 close：索引可能正持有同一实例（关掉会打断索引）
    // 词法通道：FTS MATCH bigram 查询（body 写入侧已 bigram 化），bm25 负值越小越
    // 相关，升序即名次；名次只取决于 SQL 返回顺序，bm25 分值本身不参与融合。
    // 短语 AND 零命中时降级 OR 重查（长问句只有部分重叠也要能召回）。
    const runLexical = (expr: string) =>
      db
        .query(
          // bm25() 是负值且越小越相关：取负换成「越大越相关」的普通分数，供 min-max 归一
          `SELECT c.id AS id, -bm25(chunks_fts) AS score
             FROM chunks_fts
             JOIN chunks c ON c.id = chunks_fts.chunk_id
            WHERE chunks_fts MATCH ?
            ORDER BY score DESC
            LIMIT ${CHANNEL_TOP_N}`,
        )
        .all(expr) as Array<{ id: string; score: number }>;
    let lexical = matchExpr ? runLexical(matchExpr) : [];
    if (lexical.length === 0) {
      const orExpr = buildOrMatchExpr(query);
      if (orExpr) lexical = runLexical(orExpr);
    }
    const lexicalIds = new Set(lexical.map((r) => r.id));
    // 语义通道：量化扫描（扫描宽度远大于融合条数）→ 距离门过滤；
    // 指纹不匹配或查询向量缺失时整通道跳过（扫描失败扩展内部降级为空数组）。
    const semantic =
      queryVec && !mismatch
        ? kbQuantizedScan(db, queryVec, KB_SCAN_K).filter((h) => withinSemanticDistance(h.distance))
        : [];

    // 库内加权分数融合（替代原先的 RRF 名次融合）：两路各自 min-max 归一后
    // 0.45·BM25 + 0.55·向量 + 0.15·双路加成，保留分数分布信息
    const fused = weightedScoreFusion(
      lexical.map((r) => ({ chunkId: r.id, score: r.score })),
      semantic.map((h) => ({ chunkId: h.id, score: 1 - h.distance })),
    );
    if (fused.length === 0) continue;

    // 按融合名次回读出处字段（id 来自库内，缺失即跳过的防御不必要——IN 查询必命中）
    const placeholders = fused.map(() => "?").join(",");
    const rows = db
      .query(
        `SELECT id, content, file_path, title, breadcrumb, start_line, end_line, file_mtime
           FROM chunks WHERE id IN (${placeholders})`,
      )
      .all(...fused.map((f) => f.chunkId)) as Array<{
      id: string;
      content: string;
      file_path: string;
      title: string | null;
      breadcrumb: string | null;
      start_line: number | null;
      end_line: number | null;
      file_mtime: number;
    }>;
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const { chunkId: id, score } of fused) {
      const row = byId.get(id);
      if (!row) continue;
      // 置信门（分数）+ 词法证据门（覆盖率）：低分与「与查询几乎无词法重叠」的块不进结果。
      // 词法门需要正文，所以放在回读之后（管线：召回→融合→分数门→回读→词法门→boost→多样性→截断→扩窗）
      if (score < MIN_HYBRID_SCORE) continue;
      // 词法门只约束「词法通道命中过的块」；纯语义命中（词法零重叠）是语义模式的价值所在，
      // 由分数门单独把关（否则「字面不同、意思相近」的命中会被整体杀掉）
      if (lexicalIds.has(id) && !hasEnoughLexicalEvidence(row.content, queryTokens)) continue;
      merged.push({
        hit: {
          kbId,
          kbName: kb.name,
          content: row.content,
          filePath: row.file_path,
          title: row.title,
          breadcrumb: row.breadcrumb,
          startLine: row.start_line,
          endLine: row.end_line,
          score,
          ...(staleKb ? { stale: true } : {}),
        },
        root: kb.folderPath,
        recordedMtime: row.file_mtime,
      });
    }
  }

  // 跨库合并：按融合分降序截 limit（limit≤0 时 slice 语义不安全，钳到 0）
  merged.sort((a, b) => b.hit.score - a.hit.score);
  const top = merged.slice(0, Math.max(0, limit));
  // 新鲜度只核对最终返回的这几条（≤limit 次 stat，并发不放大 IO）；整库已标 stale 的短路不再 stat
  await Promise.all(
    top.map(async ({ hit, root, recordedMtime }) => {
      if (hit.stale) return;
      if (await sourceChanged(root, hit.filePath, recordedMtime, statFn)) hit.stale = true;
    }),
  );
  const results = top.map((e) => e.hit);
  return { found: results.length > 0, results, skippedKbs };
}
