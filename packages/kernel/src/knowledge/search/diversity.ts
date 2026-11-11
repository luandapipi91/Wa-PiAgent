// 移植自 pi-knowledge@0.13.0 dist/src/search/diversity.js（MIT）
// 检索结果多样性：MMR（λ·相关度 − (1−λ)·与已选的最大冗余）+ 按文件轮转。
// 冗余度取「行邻近 / 词法 Jaccard / 向量余弦×0.35」三者的最大值；不设「单文件最多 N 条」
// 硬上限——同文件挤压交由冗余惩罚与文件轮转处理。函数逐字搬运上游，
// 仅把 chunk 形状换成 Wa-Pi 的 RankChunk（camelCase 字段）。
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { throwIfAborted } from "./contracts";
import type { RankChunk } from "./contracts";
import type { RankingDiagnostics } from "./ranking";
import { tokenizeForSearch } from "./query";

const VECTOR_REDUNDANCY_WEIGHT = 0.35;
const PAIR_CHECK_INTERVAL = 1_024;
const CPU_SLICE_MS = 8;

export type DiversityMode = "off" | "balanced" | "strong" | undefined;

/** 待多样化的排序条目（字段同上游 ranked 条目，chunk 换成 RankChunk） */
export interface RankedCandidate {
  chunk: RankChunk;
  kbName: string;
  /** 库根绝对路径（结果组装用；多样性排序不读它） */
  kbFolderPath?: string;
  ranking?: RankingDiagnostics;
  score: number;
  content: string;
  snippet: string;
  startLine: number;
  endLine: number;
  sourceChunkIds: string[];
}

interface ProximityMeta {
  filePath: string;
  kbId: string;
  startLine: number;
  endLine: number;
  sourceIds: Set<string>;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const token of small) {
    if (large.has(token)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

function proximityMeta(candidate: RankedCandidate): ProximityMeta {
  return {
    filePath: candidate.chunk.filePath,
    kbId: candidate.chunk.kbId,
    startLine: candidate.startLine,
    endLine: candidate.endLine,
    sourceIds: new Set(candidate.sourceChunkIds),
  };
}

/** 行邻近：同块（sourceIds 相交）或行区间重叠 = 1；gap ≤20 → 0.8、≤80 → 0.45、否则 0.2 */
function lineProximity(a: ProximityMeta, b: ProximityMeta): number {
  if (a.filePath !== b.filePath || a.kbId !== b.kbId) return 0;
  const [small, large] = a.sourceIds.size <= b.sourceIds.size ? [a.sourceIds, b.sourceIds] : [b.sourceIds, a.sourceIds];
  for (const id of small) {
    if (large.has(id)) return 1;
  }
  const overlap = Math.max(0, Math.min(a.endLine, b.endLine) - Math.max(a.startLine, b.startLine) + 1);
  if (overlap > 0) return 1;
  const gap = Math.max(a.startLine, b.startLine) - Math.min(a.endLine, b.endLine);
  if (gap <= 20) return 0.8;
  if (gap <= 80) return 0.45;
  return 0.2;
}

/** 相关度 min-max 归一；全体同分时一律 1（无区分度，退化成分数不参与决策） */
function normalizeScores(candidates: RankedCandidate[]): Float64Array {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate.score < min) min = candidate.score;
    if (candidate.score > max) max = candidate.score;
  }
  const normalized = new Float64Array(candidates.length);
  for (let i = 0; i < candidates.length; i++) {
    normalized[i] = max === min ? 1 : (candidates[i].score - min) / (max - min);
  }
  return normalized;
}

function firstUnusedIndex(used: Uint8Array): number {
  for (let i = 0; i < used.length; i++) {
    if (used[i] === 0) return i;
  }
  throw new Error("Diversity selection exhausted its candidate pool unexpectedly");
}

/**
 * MMR 选择：每轮在未选集合里挑 `λ·相关度 − (1−λ)·与已选的最大冗余` 最高者。
 * λ：strong=0.62（更早推开冗余项）、balanced=0.76。off 或 ≤2 条直通（返回原数组）。
 * 每算 PAIR_CHECK_INTERVAL 对冗余检查一次取消信号与 CPU 时间片，超 CPU_SLICE_MS 让出事件循环。
 */
export async function diversifyRankedChunks(
  candidates: RankedCandidate[],
  diversity: DiversityMode,
  vectorsByChunkId: Map<string, Float32Array> = new Map(),
  signal?: AbortSignal,
): Promise<RankedCandidate[]> {
  throwIfAborted(signal);
  if (diversity === "off" || candidates.length <= 2) return candidates;
  const lambda = diversity === "strong" ? 0.62 : 0.76;
  const n = candidates.length;
  const tokenSets = new Array<Set<string>>(n);
  const vectors = new Array<Float32Array | undefined>(n);
  const metas = new Array<ProximityMeta>(n);
  const relevance = normalizeScores(candidates);
  for (let i = 0; i < n; i++) {
    const candidate = candidates[i];
    tokenSets[i] = tokenizeForSearch(candidate.content);
    vectors[i] = vectorsByChunkId.get(candidate.chunk.id);
    metas[i] = proximityMeta(candidate);
  }
  const pairRedundancy = (a: number, b: number): number => {
    let best = lineProximity(metas[a], metas[b]);
    const lexical = jaccardSimilarity(tokenSets[a], tokenSets[b]);
    if (lexical > best) best = lexical;
    const va = vectors[a];
    const vb = vectors[b];
    if (va !== undefined && vb !== undefined) {
      const vector = Math.max(0, cosineSimilarity(va, vb)) * VECTOR_REDUNDANCY_WEIGHT;
      if (vector > best) best = vector;
    }
    return best;
  };
  const redundancy = new Float64Array(n);
  const used = new Uint8Array(n);
  const selected = new Array<RankedCandidate>(n);
  let pairsSinceCheck = 0;
  let sliceStartedAt = performance.now();
  for (let round = 0; round < n; round++) {
    throwIfAborted(signal);
    let bestIndex = firstUnusedIndex(used);
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < n; i++) {
      if (used[i] === 1) continue;
      const mmrScore = lambda * relevance[i] - (1 - lambda) * redundancy[i];
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIndex = i;
      }
    }
    used[bestIndex] = 1;
    selected[round] = candidates[bestIndex];
    for (let i = 0; i < n; i++) {
      if (used[i] === 1) continue;
      const pair = pairRedundancy(bestIndex, i);
      if (pair > redundancy[i]) redundancy[i] = pair;
      pairsSinceCheck++;
      if (pairsSinceCheck < PAIR_CHECK_INTERVAL) continue;
      pairsSinceCheck = 0;
      throwIfAborted(signal);
      if (performance.now() - sliceStartedAt < CPU_SLICE_MS) continue;
      await yieldToEventLoop();
      throwIfAborted(signal);
      sliceStartedAt = performance.now();
    }
  }
  return selected;
}

/**
 * 按文件轮转：同一「库 + 文件」的条目分桶，逐轮各桶取一条，单文件不设条数上限。
 * 只有一个文件时直通（轮转无意义）。off 或 ≤2 条同样直通。
 */
export function interleaveByFile(
  candidates: RankedCandidate[],
  diversity: DiversityMode,
  signal?: AbortSignal,
): RankedCandidate[] {
  throwIfAborted(signal);
  if (diversity === "off" || candidates.length <= 2) return candidates;
  const buckets = new Map<string, RankedCandidate[]>();
  const fileOrder: string[] = [];
  for (const candidate of candidates) {
    throwIfAborted(signal);
    const key = `${candidate.chunk.kbId}:${candidate.chunk.filePath}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
      fileOrder.push(key);
    }
    bucket.push(candidate);
  }
  if (fileOrder.length <= 1) return candidates;
  const result: RankedCandidate[] = [];
  let round = 0;
  while (result.length < candidates.length) {
    let added = false;
    for (const key of fileOrder) {
      const item = buckets.get(key)?.[round];
      if (!item) continue;
      result.push(item);
      added = true;
    }
    if (!added) break;
    round++;
  }
  return result;
}
