// 知识库检索编排：移植自 pi-knowledge@0.13.0 dist/src/engine.js 的 search()（MIT）。
//
// 管线顺序（与上游一致，勿增删）：
//   auto 分派 → tuning → window → 每库召回（fast 短路 / semantic 纯向量 / 其余 BM25+向量融合，
//   hybrid 系列带词法锚定）→ 去重 → 打分 → 门控 → 排序 → 元数据过滤 → candidatePool →
//   deep 重排 / adaptive 扩窗 → 多样性（MMR + 文件交错）→ 分页 → provenance → tuning 摘要。
//
// Wa-Pi 适配点：
//   1. 存储是「每库一个 db」，没有全局 kb_id 过滤；chunks 主键是 TEXT uuid；
//   2. KB 来源恒为目录（folderPath），kbTrustMultiplier 的 source_type 分支按 directory 处理；
//   3. 语义通道用量化扫描（kbQuantizedScan）代替上游向量文件，扫描只回距离——候选池的
//      块向量另从 chunks.embedding 回读，供 MMR 的向量冗余通道使用；
//   4. 上游只暴露 warnings/found 语义，Wa-Pi 额外保留 skippedKbs（逐个库给出跳过原因）。
import type { Database } from "bun:sqlite";
import { stat as fsStat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type {
  KbInfo,
  KbSearchHit,
  KbSearchProfile,
  KbSearchProvenance,
  KbSearchResult,
  KbSearchTuningSummary,
  KbSkippedKb,
} from "@wa-pi/shared";
import { embedQuery } from "../memory/embedder";
import { knowledgeFingerprint } from "./fingerprint";
import type { KbContext } from "./index";
import { KbDbMissingError, openKbDbExisting } from "./kb-db";
import { buildAdaptiveContext, pushAdaptiveCandidate } from "./search/adaptive";
import { searchBM25 } from "./search/bm25";
import { MAX_SEARCH_WINDOW, throwIfAborted, type RankChunk } from "./search/contracts";
import {
  diversifyRankedChunks,
  interleaveByFile,
  type RankedCandidate,
} from "./search/diversity";
import { weightedScoreFusion, type FusionResult } from "./search/fusion";
import {
  chooseAutoMode,
  fallbackModesFor,
  isWeakAutoResponse,
  matchReasonFor,
  retrievalModeFor,
  type RetrievalMode,
  type SearchMode,
} from "./search/modes";
import { normalizedQueryText, tokenizeForSearch } from "./search/query";
import {
  buildChunkEmbeddingText,
  hasAnyLexicalEvidence,
  hasEnoughLexicalEvidence,
  normalizeKbFileType,
  scoreChunkForQuery,
  type RankingDiagnostics,
} from "./search/ranking";
import { buildQuerySnippet } from "./search/snippet";
import {
  resolveSearchTuning,
  resolveSearchWindow,
  summarizeSearchTuning,
  type SearchProfile,
} from "./search/tuning";
import { KB_SCAN_K, kbQuantizedScan, withinSemanticDistance } from "./vector";

export type { KbSearchHit, KbSearchResult, KbSkippedKb } from "@wa-pi/shared";

/** 查询嵌入函数形状：缺省用真实 embedQuery，测试注入 fake 绕开模型（同 indexer 的 EmbedFn 模式） */
export type QueryEmbedFn = (text: string) => Promise<Uint8Array | null>;
/** 重排函数形状（上游签名 rerank(query, candidates, topK, signal)，返回按分降序的命中）；
 *  返回空数组 = 重排不可用，退化普通排序 */
export type RerankFn = (
  query: string,
  candidates: Array<{ chunkId: string; content: string }>,
  topK: number,
  signal?: AbortSignal,
) => Promise<Array<{ chunkId: string; score: number }>>;
/** 源文件 stat 函数形状：缺省真 fs，测试注入计数/伪造实现 */
export type StatFn = (path: string) => Promise<{ mtimeMs: number }>;

/** 结果多样性档位（"off" 直通；balanced/strong 对应 MMR 的 λ） */
export type SearchDiversity = "off" | "balanced" | "strong";

export interface SearchOptions {
  /** 12 个对外 mode（缺省 hybrid）；auto 会按查询形状分派并在弱结果时回退 */
  mode?: SearchMode;
  /** 调优 profile（缺省 auto：按 mode / 查询形状选） */
  profile?: SearchProfile;
  /** 页大小 1-50（缺省取 profile 的 defaultLimit） */
  limit?: number;
  /** 分页偏移（非负；offset+limit ≤ 800） */
  offset?: number;
  /** 在已绑定库里只检索这个库（id 或库名） */
  kbId?: string;
  /** 按文件类型过滤：接受 Wa-Pi 存储值（md/txt/docx/pdf/html）与上游别名（markdown/text/ts…） */
  fileType?: string;
  /** 按相对路径子串过滤 */
  pathPattern?: string;
  /** 多样性档位（缺省 balanced） */
  diversity?: SearchDiversity;
  /** 上游同名参数占位：Wa-Pi 始终返回 tuning 摘要，本开关暂无额外输出 */
  diagnostics?: boolean;
  /** 查询嵌入注入点（缺省用真实 embedQuery） */
  embedQueryFn?: QueryEmbedFn;
  /** 重排注入点（缺省用真实 reranker；测试可注入假打分器） */
  rerankFn?: RerankFn;
  /** 新鲜度核对注入点（缺省 fs.promises.stat） */
  statFn?: StatFn;
  /** 取消信号（按库/候选/多样性分层检查） */
  signal?: AbortSignal;
}

/** 打开后的单库运行时：连接、信任系数、是否整库旧索引、向量通道是否可用 */
interface KbRuntime {
  kb: KbInfo;
  db: Database;
  trust: number;
  /** status=error 但仍有旧索引（上游 status=stale）→ 结果逐条标 stale */
  stale: boolean;
  /** 库级模型指纹与当前不一致：向量通道降级（词法照常） */
  mismatch: boolean;
}

/** 单条召回（融合后、回读正文前）：chunkId 全局唯一（uuid 主键） */
interface Recalled {
  chunkId: string;
  kbId: string;
  score: number;
}

/** chunks 表投影（排序/出处需要的列；embedding 不回读，按需单独取） */
interface ChunkRow {
  id: string;
  file_path: string;
  file_type: string;
  title: string | null;
  breadcrumb: string | null;
  start_line: number | null;
  end_line: number | null;
  content: string;
  content_hash: string;
  file_mtime: number;
  updated_at: number;
}

/** 打分后的候选 */
interface ScoredCandidate {
  chunk: RankChunk;
  row: ChunkRow;
  kbId: string;
  score: number;
  ranking: RankingDiagnostics;
}

const CHUNK_COLUMNS =
  "id, file_path, file_type, title, breadcrumb, start_line, end_line, content, content_hash, file_mtime, updated_at";

/**
 * 库信任系数（照抄上游 engine.js 的 kbTrustMultiplier）：
 * 旧索引（上游 status=stale）×0.92；directory/file ×1.04；text/url ×0.98。
 * Wa-Pi 的知识库只有「目录」一种来源，故恒乘 1.04。
 */
function kbTrustMultiplier(staleKb: boolean): number {
  let multiplier = staleKb ? 0.92 : 1;
  multiplier *= 1.04; // directory
  return multiplier;
}

function toRankChunk(row: ChunkRow, kbId: string): RankChunk {
  return {
    id: row.id,
    kbId,
    filePath: row.file_path,
    fileType: normalizeKbFileType(row.file_type),
    content: row.content,
    contentHash: row.content_hash,
    startLine: row.start_line,
    endLine: row.end_line,
    indexedAt: row.updated_at,
    title: row.title,
    breadcrumb: row.breadcrumb,
  };
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

/** SQLite 绑定参数上限保守值（老构建默认 999；候选池最多可达 800+扫描宽度） */
const IN_CLAUSE_CHUNK = 500;

/** 按 ≤IN_CLAUSE_CHUNK 分批执行 `WHERE id IN (...)`，返回全部行 */
function queryByIds<T>(
  db: Database,
  sqlPrefix: string,
  ids: string[],
  extra = "",
): T[] {
  const rows: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CLAUSE_CHUNK) {
    const slice = ids.slice(i, i + IN_CLAUSE_CHUNK);
    const placeholders = slice.map(() => "?").join(",");
    rows.push(...(db.query(`${sqlPrefix} (${placeholders})${extra}`).all(...slice) as T[]));
  }
  return rows;
}

function groupIdsByKb(items: Recalled[]): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  for (const item of items) {
    const ids = grouped.get(item.kbId);
    if (ids) ids.push(item.chunkId);
    else grouped.set(item.kbId, [item.chunkId]);
  }
  return grouped;
}

/** 批量回读候选块的正文/出处列（按库分组，每库一条 IN 查询） */
function loadChunkRows(
  unique: Recalled[],
  runtimeByKbId: Map<string, KbRuntime>,
): Map<string, ChunkRow> {
  const rowsById = new Map<string, ChunkRow>();
  for (const [kbId, ids] of groupIdsByKb(unique)) {
    const runtime = runtimeByKbId.get(kbId);
    if (!runtime) continue;
    const rows = queryByIds<ChunkRow>(runtime.db, `SELECT ${CHUNK_COLUMNS} FROM chunks WHERE id IN`, ids);
    for (const row of rows) rowsById.set(row.id, row);
  }
  return rowsById;
}

/**
 * 候选池的块向量：量化扫描只回距离，MMR 的向量冗余通道（余弦×0.35）需要原始向量，
 * 这里按候选 id 从 chunks.embedding 回读（候选池 ≤ 800 条，一条查询/库）。
 * 库级指纹不匹配（向量过期）的库跳过；≤2 条候选时 diversity 直通，无需回读。
 */
function loadCandidateVectors(
  candidatePool: ScoredCandidate[],
  runtimeByKbId: Map<string, KbRuntime>,
): Map<string, Float32Array> {
  const vectors = new Map<string, Float32Array>();
  if (candidatePool.length <= 2) return vectors;
  const grouped = new Map<string, string[]>();
  for (const candidate of candidatePool) {
    const ids = grouped.get(candidate.kbId);
    if (ids) ids.push(candidate.chunk.id);
    else grouped.set(candidate.kbId, [candidate.chunk.id]);
  }
  for (const [kbId, ids] of grouped) {
    const runtime = runtimeByKbId.get(kbId);
    if (!runtime || runtime.mismatch) continue;
    const rows = queryByIds<{ id: string; embedding: Uint8Array }>(
      runtime.db,
      "SELECT id, embedding FROM chunks WHERE id IN",
      ids,
      " AND embedding IS NOT NULL",
    );
    for (const row of rows) {
      const bytes = row.embedding;
      if (bytes.byteLength === 0 || bytes.byteLength % 4 !== 0) continue;
      const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      vectors.set(row.id, new Float32Array(copy));
    }
  }
  return vectors;
}

/**
 * adaptive 扩窗的取块范围：同库同文件、行区间与 [start-line, end+line] 相交的块。
 * 行号可空（上游必填）：空的块按 COALESCE 0 处理，天然不参与行窗（与上游 getChunksByFile 一致）。
 */
function chunksInWindow(runtime: KbRuntime, chunk: RankChunk, lines: number): RankChunk[] {
  const startLine = Math.max(1, (chunk.startLine ?? 0) - lines);
  const endLine = (chunk.endLine ?? chunk.startLine ?? 0) + lines;
  const rows = runtime.db
    .query(
      `SELECT ${CHUNK_COLUMNS} FROM chunks
        WHERE file_path = ? AND COALESCE(end_line, 0) >= ? AND COALESCE(start_line, 0) <= ?
        ORDER BY COALESCE(start_line, 0), COALESCE(end_line, 0)`,
    )
    .all(chunk.filePath, startLine, endLine) as ChunkRow[];
  return rows.map((row) => toRankChunk(row, runtime.kb.id));
}

/** 合并两次结果的 skippedKbs（kbId+reason 去重） */
function mergeSkipped(target: KbSkippedKb[], source: KbSkippedKb[]): void {
  for (const item of source) {
    if (!target.some((s) => s.kbId === item.kbId && s.reason === item.reason)) target.push(item);
  }
}

/**
 * 跨库检索。kbIds 顺序执行（SQLite 毫秒级操作，并发无收益还要管理连接生命周期）；
 * 查询嵌入全流程最多算一次（跨库复用）。
 */
export async function searchKnowledge(
  ctx: KbContext,
  kbIds: string[],
  query: string,
  opts: SearchOptions = {},
): Promise<KbSearchResult> {
  const requestedMode = opts.mode ?? "hybrid";
  throwIfAborted(opts.signal);
  // auto：按查询形状挑主模式，结果弱时按回退链重试（最多 3 次）
  if (requestedMode === "auto") {
    return searchAuto(ctx, kbIds, query, opts);
  }
  // 12 个对外 mode 先归一到检索策略（code/config/errors → fast，docs/decision → hybrid）
  const retrievalMode = retrievalModeFor(requestedMode);
  // adaptive 的召回按 hybrid 跑，扩窗在候选池之后单独做
  const recallMode = retrievalMode === "adaptive" ? "hybrid" : retrievalMode;
  const bm25Query = normalizedQueryText(query) || query;
  const queryTokens = tokenizeForSearch(query);
  const normalizedFileType = opts.fileType ? normalizeKbFileType(opts.fileType) : undefined;
  const skippedKbs: KbSkippedKb[] = [];
  const warnings: string[] = [];

  // 绑定清单 → 可用库（缺失/重复/未选中的库在这里归一）
  const kbs: KbInfo[] = [];
  const seenKbIds = new Set<string>();
  for (const kbId of kbIds) {
    const kb = ctx.store.getKb(kbId);
    if (!kb) {
      skippedKbs.push({ kbId, reason: "missing" });
      continue;
    }
    if (opts.kbId && kb.id !== opts.kbId && kb.name !== opts.kbId) continue;
    if (seenKbIds.has(kb.id)) continue;
    seenKbIds.add(kb.id);
    kbs.push(kb);
  }
  // kbId 过滤后一个库都不剩（kbId 写错/库已删）时必须显式报出，
  // 否则与「库里没这内容」不可区分：用户看到空结果却查不出原因
  if (opts.kbId && kbs.length === 0) {
    skippedKbs.push({ kbId: opts.kbId, reason: "kb_not_found" });
  }

  const tuning = resolveSearchTuning({
    query,
    mode: requestedMode,
    profile: opts.profile,
    kbSourceTypes: kbs.map(() => "directory"),
  });
  const { limit, offset } = resolveSearchWindow(opts.limit, opts.offset, tuning.defaultLimit);
  const candidateLimit = Math.min(
    MAX_SEARCH_WINDOW,
    Math.max(tuning.candidateMin, offset + limit * tuning.candidateMultiplier),
  );
  const tuningSummary = summarizeSearchTuning(tuning, limit, candidateLimit);

  // 打开每库连接（缓存复用，不 close）：旧索引（status=error 但 chunkCount>0）仍可检索并标 stale
  const runtimeByKbId = new Map<string, KbRuntime>();
  for (const kb of kbs) {
    const stale = kb.status === "error" && kb.chunkCount > 0 && kb.lastIndexedAt !== null;
    if (kb.status !== "ready" && !stale) {
      skippedKbs.push({ kbId: kb.id, reason: "not_ready" });
      continue;
    }
    // 空库静默跳过（对齐上游 `if (kb.chunk_count === 0) continue`）：
    // 否则会走召回并产出误导性的 `no lexical match` warning
    if (kb.chunkCount === 0) continue;
    let mismatch = false;
    // 库级指纹直读登记库（KbInfo 投影不含 embed_meta）：null = 从未索引，不算不匹配。
    // 不匹配只降级向量通道（存量向量全部过期），词法照常，仍参与检索。
    const storedMeta = ctx.store.getEmbedMeta(kb.id);
    if (storedMeta !== null && storedMeta !== knowledgeFingerprint()) {
      mismatch = true;
      // 库仍参与检索（词法照常），不是「被跳过」：走 warnings 而不是 skippedKbs
      warnings.push(`「${kb.name}」向量通道已禁用（embedding 指纹不匹配），仅返回词法结果`);
    }
    // 检索路径用「只开已存在的库」：库文件丢失时必须显式报出（skippedKbs），
    // 否则 openKbDb 会当场建一个空库 → 检索恒零命中，用户看到的是「库里没这内容」
    let db: Database;
    try {
      db = openKbDbExisting(ctx.waPiDir, kb.id);
    } catch (err) {
      if (err instanceof KbDbMissingError) {
        skippedKbs.push({ kbId: kb.id, reason: "db_missing" });
      } else {
        console.warn(`[knowledge] 知识库 db 打开失败 (kbId=${kb.id}):`, err);
        skippedKbs.push({ kbId: kb.id, reason: "db_error" });
      }
      continue;
    }
    runtimeByKbId.set(kb.id, {
      kb,
      db,
      trust: kbTrustMultiplier(stale),
      stale,
      mismatch,
    });
  }

  // 每库召回：fast 只严格 BM25（短路，不过融合）；semantic 只量化扫描；
  // 其余 BM25 + 向量 → weightedScoreFusion，hybrid 系列在 BM25 零命中时整库跳过（词法锚定）。
  const allResults: Recalled[] = [];
  let queryEmbedding: Uint8Array | null | undefined;
  const ensureQueryEmbedding = async (): Promise<Uint8Array | null> => {
    if (queryEmbedding === undefined) {
      queryEmbedding = await (opts.embedQueryFn ?? embedQuery)(query);
    }
    return queryEmbedding;
  };

  for (const runtime of runtimeByKbId.values()) {
    throwIfAborted(opts.signal);
    if (recallMode === "fast") {
      const hits = searchBM25(runtime.db, bm25Query, candidateLimit, { allowOrFallback: false });
      for (const hit of hits) {
        allResults.push({
          chunkId: hit.chunkId,
          kbId: runtime.kb.id,
          score: hit.score * runtime.trust,
        });
      }
      continue;
    }
    if (recallMode === "semantic") {
      if (runtime.mismatch) continue;
      const queryVec = await ensureQueryEmbedding();
      if (!queryVec) continue;
      const hits = kbQuantizedScan(runtime.db, queryVec, KB_SCAN_K).filter((hit) =>
        withinSemanticDistance(hit.distance),
      );
      for (const hit of hits) {
        allResults.push({
          chunkId: hit.id,
          kbId: runtime.kb.id,
          score: (1 - hit.distance) * runtime.trust,
        });
      }
      continue;
    }
    const bm25 = searchBM25(runtime.db, bm25Query, candidateLimit);
    // 词法锚定（hybrid/adaptive/deep 的硬规则）：BM25 零命中就整库跳过，
    // 不让低证据的纯语义命中混进结果——这是 hybrid 与 semantic_hybrid 的核心差别。
    if (bm25.length === 0 && recallMode !== "semantic_hybrid") {
      skippedKbs.push({ kbId: runtime.kb.id, reason: "lexical_anchor" });
      warnings.push(
        `"${runtime.kb.name}" has no lexical match for this query; skipped (hybrid modes require lexical anchoring)`,
      );
      continue;
    }
    const queryVec = runtime.mismatch ? null : await ensureQueryEmbedding();
    const semantic: FusionResult[] = queryVec
      ? kbQuantizedScan(runtime.db, queryVec, KB_SCAN_K)
          .filter((hit) => withinSemanticDistance(hit.distance))
          .map((hit) => ({ chunkId: hit.id, score: 1 - hit.distance }))
      : [];
    const fused = weightedScoreFusion(bm25, semantic);
    for (const hit of fused) {
      allResults.push({
        chunkId: hit.chunkId,
        kbId: runtime.kb.id,
        score: hit.score * runtime.trust,
      });
    }
  }

  // 跨库按 chunkId 去重 → 回读正文 → 打分（scoreChunkForQuery 的 adjusted_score 覆盖融合分）
  const seenChunkIds = new Set<string>();
  const unique: Recalled[] = [];
  for (const result of allResults) {
    if (seenChunkIds.has(result.chunkId)) continue;
    seenChunkIds.add(result.chunkId);
    unique.push(result);
  }
  const rowsById = loadChunkRows(unique, runtimeByKbId);
  const screened: ScoredCandidate[] = [];
  for (const result of unique) {
    throwIfAborted(opts.signal);
    const row = rowsById.get(result.chunkId);
    if (!row) continue;
    const chunk = toRankChunk(row, result.kbId);
    const ranking = scoreChunkForQuery(result.score, chunk, queryTokens);
    screened.push({ chunk, row, kbId: result.kbId, score: ranking.adjusted_score, ranking });
  }

  // 门控：fast 只要有词法证据；semantic 不过门（距离门已在上游）；semantic_hybrid 只分数门；
  // 其余（hybrid/adaptive/deep）分数门 + 词法证据门。
  let gated: ScoredCandidate[];
  if (recallMode === "fast") {
    gated = screened.filter((candidate) =>
      hasAnyLexicalEvidence(buildChunkEmbeddingText(candidate.chunk), queryTokens),
    );
  } else if (recallMode === "semantic") {
    gated = screened;
  } else if (recallMode === "semantic_hybrid") {
    gated = screened.filter((candidate) => candidate.score >= tuning.minHybridScore);
  } else {
    gated = screened.filter(
      (candidate) =>
        candidate.score >= tuning.minHybridScore &&
        hasEnoughLexicalEvidence(candidate.chunk, queryTokens),
    );
  }

  // 排序 → 元数据过滤（file_type / path_pattern）→ 候选池截断
  gated.sort((a, b) => b.score - a.score);
  let filtered = gated;
  if (normalizedFileType || opts.pathPattern) {
    filtered = gated.filter((candidate) => {
      if (normalizedFileType && candidate.chunk.fileType !== normalizedFileType) return false;
      if (opts.pathPattern && !candidate.chunk.filePath.includes(opts.pathPattern)) return false;
      return true;
    });
  }
  const candidatePool = filtered.slice(0, candidateLimit);
  const candidatePoolTruncated = candidatePool.length < filtered.length;
  const diversity = opts.diversity ?? "balanced";
  // fast 短路不参与融合；diversity=off 直通，不需要块向量（避免无谓回读最高 800 条 embedding）
  const vectorsByChunkId =
    recallMode === "fast" || diversity === "off"
      ? new Map<string, Float32Array>()
      : loadCandidateVectors(candidatePool, runtimeByKbId);
  const kbNameOf = (kbId: string): string => runtimeByKbId.get(kbId)?.kb.name ?? "unknown";
  const kbFolderOf = (kbId: string): string => runtimeByKbId.get(kbId)?.kb.folderPath ?? "";

  // deep：只对前 deepRerankCandidates 条做 cross-encoder 重排（未就绪/失败 → 走普通排序，
  // modeUsed 仍报 deep，rerankUsed=false）。注意用入参 mode 判定，不是归一后的 retrievalMode。
  let ranked: RankedCandidate[] = [];
  let rerankUsed = false;
  if (requestedMode === "deep" && candidatePool.length > 0) {
    const { rerank, isRerankerReady } = await import("./reranker");
    const rerankCandidates = candidatePool.slice(0, tuning.deepRerankCandidates);
    // 上游 rerank() 内部按 topK = max(limit × deepRerankTopKMultiplier, limit) 截断；
    // 不截断会让 totalCount/多样性池远大于上游（重排候选最多 30 条全进结果）
    const topK = Math.max(limit * tuning.deepRerankTopKMultiplier, limit);
    // 未就绪不触发加载：下载只由设置页「开启」显式触发，检索路径只消费已就绪的模型
    const rerankFn: RerankFn | null = opts.rerankFn ?? (isRerankerReady() ? rerank : null);
    const hits = rerankFn
      ? await rerankFn(
          query,
          rerankCandidates.map((candidate) => ({
            chunkId: candidate.chunk.id,
            content: candidate.row.content,
          })),
          topK,
          opts.signal,
        )
      : [];
    throwIfAborted(opts.signal);
    if (hits.length > 0) {
      rerankUsed = true;
      const byChunkId = new Map(
        rerankCandidates.map((candidate) => [candidate.chunk.id, candidate]),
      );
      // 上游 rerank() 已按分降序并截断；这里再兜一次，保证注入的假重排器也守同一契约
      for (const { chunkId, score } of hits.slice(0, topK)) {
        const candidate = byChunkId.get(chunkId);
        if (!candidate) continue;
        ranked.push({
          chunk: candidate.chunk,
          kbName: kbNameOf(candidate.kbId),
          kbFolderPath: kbFolderOf(candidate.chunk.kbId),
          ranking: scoreChunkForQuery(score, candidate.chunk, queryTokens),
          score,
          content: candidate.row.content,
          snippet: buildQuerySnippet(candidate.row.content, query, tuning.snippetMaxLength),
          startLine: candidate.chunk.startLine ?? 0,
          endLine: candidate.chunk.endLine ?? 0,
          sourceChunkIds: [candidate.chunk.id],
        });
      }
    }
  }

  if (!rerankUsed) {
    for (const candidate of candidatePool) {
      throwIfAborted(opts.signal);
      if (requestedMode === "adaptive") {
        // adaptive：同文件行窗取上下文，seed ∈ chunks（空窗口时回退 [seed]）
        const runtime = runtimeByKbId.get(candidate.kbId);
        const contextChunks = runtime
          ? chunksInWindow(runtime, candidate.chunk, tuning.adaptiveContextLines)
          : [];
        const context = buildAdaptiveContext(
          candidate.chunk,
          contextChunks.length > 0 ? contextChunks : [candidate.chunk],
          queryTokens,
          {
            maxContextChars: tuning.adaptiveMaxContextChars,
            neighborTarget: tuning.adaptiveNeighborTarget,
          },
        );
        pushAdaptiveCandidate(ranked, {
          chunk: candidate.chunk,
          kbName: kbNameOf(candidate.kbId),
          kbFolderPath: kbFolderOf(candidate.chunk.kbId),
          ranking: candidate.ranking,
          score: candidate.score,
          content: context.content,
          snippet: buildQuerySnippet(context.content, query, tuning.snippetMaxLength),
          startLine: context.startLine,
          endLine: context.endLine,
          sourceChunkIds: context.sourceChunkIds,
        });
      } else {
        ranked.push({
          chunk: candidate.chunk,
          kbName: kbNameOf(candidate.kbId),
          kbFolderPath: kbFolderOf(candidate.chunk.kbId),
          ranking: candidate.ranking,
          score: candidate.score,
          content: candidate.row.content,
          snippet: buildQuerySnippet(candidate.row.content, query, tuning.snippetMaxLength),
          startLine: candidate.chunk.startLine ?? 0,
          endLine: candidate.chunk.endLine ?? 0,
          sourceChunkIds: [candidate.chunk.id],
        });
      }
    }
  }

  // 多样性（MMR）+ 按文件交错必须在截断前：否则单文件相邻块会把 limit 占满
  const diversified = interleaveByFile(
    await diversifyRankedChunks(ranked, diversity, vectorsByChunkId, opts.signal),
    diversity,
    opts.signal,
  );
  const totalCount = diversified.length;
  const page = diversified.slice(offset, offset + limit);

  // 新鲜度只核对最终返回的这几条（≤limit 次 stat）；整库旧索引的直接短路
  const statFn = opts.statFn ?? fsStat;
  const staleFlags = await Promise.all(
    page.map(async (entry) => {
      const runtime = runtimeByKbId.get(entry.chunk.kbId);
      if (!runtime || runtime.stale) return true;
      const recordedMtime = rowsById.get(entry.chunk.id)?.file_mtime ?? 0;
      return sourceChanged(runtime.kb.folderPath, entry.chunk.filePath, recordedMtime, statFn);
    }),
  );

  const isAdaptive = requestedMode === "adaptive";
  const results: KbSearchHit[] = page.map((entry, index) => {
    const row = rowsById.get(entry.chunk.id);
    const stale = staleFlags[index];
    const provenance: KbSearchProvenance = {
      chunk_id: entry.chunk.id,
      chunk_hash: entry.chunk.contentHash,
      indexed_at: entry.chunk.indexedAt,
      ...(row ? { source_mtime: row.file_mtime } : {}),
      stale,
      match_reason: matchReasonFor(requestedMode),
      source_chunk_ids: entry.sourceChunkIds,
    };
    return {
      kbId: entry.chunk.kbId,
      kbName: entry.kbName,
      kbFolderPath: entry.kbFolderPath ?? kbFolderOf(entry.chunk.kbId),
      content: entry.content,
      filePath: entry.chunk.filePath,
      fileType: entry.chunk.fileType,
      title: entry.chunk.title ?? null,
      breadcrumb: entry.chunk.breadcrumb ?? null,
      startLine: isAdaptive ? entry.startLine : entry.chunk.startLine,
      endLine: isAdaptive ? entry.endLine : entry.chunk.endLine,
      score: entry.score,
      snippet: entry.snippet,
      ranking: entry.ranking ?? scoreChunkForQuery(entry.score, entry.chunk, queryTokens),
      provenance,
      ...(stale ? { stale: true } : {}),
    };
  });

  return {
    found: results.length > 0,
    results,
    skippedKbs,
    modeUsed: requestedMode,
    rerankUsed,
    totalCount,
    hasMore: offset + limit < totalCount,
    ...(warnings.length > 0 ? { warnings: [...new Set(warnings)] } : {}),
    // 空结果时的重试建议（逐字对齐上游 engine.search 的两条文案）
    ...(results.length === 0
      ? {
          suggestions: [
            "Try mode 'fast' for exact symbols, mode 'semantic' for pure vector search, or mode 'semantic_hybrid' when weak lexical overlap should not block fused vector results.",
            "Run knowledge_status if the KB should contain this answer.",
          ],
        }
      : {}),
    tuning: {
      ...tuningSummary,
      retrieved_candidates: unique.length,
      filtered_candidates: filtered.length,
      diversity_candidates: ranked.length,
      candidate_pool_truncated: candidatePoolTruncated,
    } satisfies KbSearchTuningSummary,
  };
}

/**
 * auto 模式：按查询形状选主模式，弱结果按回退链重试（最多 3 次）。
 * 每次尝试都完整跑一遍管线（门控/扩窗/重排按该模式的规格）；
 * 取第一次「不弱」的结果，全弱则返回空结果并把尝试链写进 retryModes。
 */
async function searchAuto(
  ctx: KbContext,
  kbIds: string[],
  query: string,
  opts: SearchOptions,
): Promise<KbSearchResult> {
  const primaryMode = chooseAutoMode(query);
  const attempts = [primaryMode, ...fallbackModesFor(primaryMode)];
  const tried: RetrievalMode[] = [];
  const warnings: string[] = [];
  const skippedKbs: KbSkippedKb[] = [];
  let last: KbSearchResult | null = null;

  for (const attemptMode of attempts) {
    if (tried.includes(attemptMode)) continue;
    tried.push(attemptMode);
    throwIfAborted(opts.signal);
    const response = await searchKnowledge(ctx, kbIds, query, { ...opts, mode: attemptMode });
    last = response;
    if (response.warnings) warnings.push(...response.warnings);
    mergeSkipped(skippedKbs, response.skippedKbs);
    const weak = isWeakAutoResponse(
      query,
      {
        results: response.results.map((hit) => ({
          file_path: hit.filePath,
          content: hit.content,
          ranking: hit.ranking,
        })),
      },
      primaryMode,
      attemptMode,
    );
    if (!weak) {
      // skippedKbs 只带「最终采用的那次尝试」的：早期尝试的跳过原因（如 hybrid 的
      // lexical_anchor）在后续尝试里可能并不成立，合并会给出「某库被跳过」的误导
      return {
        ...response,
        modeUsed: attemptMode,
        retryModes: tried.slice(0, -1),
        ...(warnings.length > 0 ? { warnings: [...new Set(warnings)] } : {}),
      };
    }
    if (tried.length >= 3) break;
  }

  if (!last) throw new Error("auto search attempted no modes");
  return {
    found: false,
    results: [],
    skippedKbs,
    modeUsed: tried.at(-1) ?? primaryMode,
    retryModes: tried.slice(0, -1),
    rerankUsed: false,
    totalCount: 0,
    hasMore: false,
    ...(warnings.length > 0 ? { warnings: [...new Set(warnings)] } : {}),
    tuning: last.tuning,
    // 全弱时给上游的重试建议（逐字对齐 engine.search）
    suggestions: [
      "No results after auto mode fallback. Check knowledge_status, try a more exact term, or rebuild the KB if indexing rules changed.",
    ],
  };
}

