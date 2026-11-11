// 移植自 pi-knowledge@0.13.0 dist/src/engine.js（MIT）
// adaptive 扩窗：命中块按「邻近距离 + 词法覆盖率 + 同作用域关系」挑邻居，拼成一段上下文。
// 仅把 chunk 形状换成 Wa-Pi 的 RankChunk（camelCase 字段）；两处适配：
//   1. 上游 chunk.metadata_json 在 Wa-Pi chunks 表暂无对应列，用可选的 metadataJson 承接，缺省时关系加成为 0；
//   2. 上游 start_line/end_line 必填，RankChunk 可为空——空行号按 0 / 起点处理。
import { queryCoverage } from "./ranking";
import type { RankChunk } from "./contracts";
import type { RankedCandidate } from "./diversity";

/** 上游 chunk 自带 metadata_json；Wa-Pi 暂无该列，留给后续接线（缺省即无 adaptive 结构） */
export interface AdaptiveChunk extends RankChunk {
  metadataJson?: string | null;
}

/** parseAdaptiveMetadata 的产物（camelCase 字段）；JSON 源键沿用上游 snake_case，不改以免破坏兼容 */
export interface AdaptiveMetadata {
  symbol?: string;
  symbolKind?: string;
  parentSymbol?: string;
  scope: string[];
  startLine?: number;
  endLine?: number;
}

function metadataString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function metadataNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function metadataStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && Boolean(item.trim()))
    : [];
}

export function parseAdaptiveMetadata(chunk: AdaptiveChunk): AdaptiveMetadata {
  try {
    const parsed = JSON.parse(chunk.metadataJson ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { scope: [] };
    const record = parsed as Record<string, unknown>;
    return {
      symbol: metadataString(record, "symbol") ?? metadataString(record, "function_name"),
      symbolKind: metadataString(record, "symbol_kind"),
      parentSymbol: metadataString(record, "parent_symbol"),
      scope: metadataStringArray(record, "scope"),
      startLine: metadataNumber(record, "start_line"),
      endLine: metadataNumber(record, "end_line"),
    };
  } catch {
    return { scope: [] };
  }
}

export function hasAdaptiveStructure(metadata: AdaptiveMetadata): boolean {
  return Boolean(metadata.symbol || metadata.symbolKind || metadata.parentSymbol || metadata.scope.length > 0);
}

function parentScope(scope: string[]): string[] {
  return scope.length > 1 ? scope.slice(0, -1) : [];
}

function sameScope(left: string[], right: string[]): boolean {
  return left.length > 0 && left.length === right.length && left.every((item, index) => item === right[index]);
}

function isScopePrefix(parent: string[], child: string[]): boolean {
  return parent.length > 0 && parent.length < child.length && parent.every((item, index) => item === child[index]);
}

export function adaptiveRelationBoost(seed: AdaptiveMetadata, candidate: AdaptiveMetadata): number {
  if (!hasAdaptiveStructure(seed) || !hasAdaptiveStructure(candidate)) return 0;
  const seedParentScope = parentScope(seed.scope);
  const candidateParentScope = parentScope(candidate.scope);
  if (sameScope(seedParentScope, candidateParentScope)) {
    return seed.symbol === candidate.symbol ? 0.35 : 1.35;
  }
  if (seed.parentSymbol && seed.parentSymbol === candidate.parentSymbol) {
    return seed.symbol === candidate.symbol ? 0.35 : 1.2;
  }
  if (isScopePrefix(seed.scope, candidate.scope) || isScopePrefix(candidate.scope, seed.scope)) {
    return 0.9;
  }
  return 0;
}

const startOf = (chunk: AdaptiveChunk): number => chunk.startLine ?? 0;
const endOf = (chunk: AdaptiveChunk): number => chunk.endLine ?? startOf(chunk);

export function buildAdaptiveContext(
  seed: AdaptiveChunk,
  chunks: AdaptiveChunk[],
  queryTokens: Set<string>,
  options: { maxContextChars: number; neighborTarget: number },
): { content: string; startLine: number; endLine: number; sourceChunkIds: string[] } {
  const seedMetadata = parseAdaptiveMetadata(seed);
  const scored = chunks
    .map((chunk) => {
      const distance =
        chunk.id === seed.id
          ? 0
          : Math.min(Math.abs(startOf(chunk) - startOf(seed)), Math.abs(endOf(chunk) - endOf(seed)));
      const proximity = 1 / (1 + distance / 20);
      const coverage = queryCoverage(chunk.content, queryTokens);
      const seedBoost = chunk.id === seed.id ? 2 : 0;
      const relationBoost =
        chunk.id === seed.id ? 0 : adaptiveRelationBoost(seedMetadata, parseAdaptiveMetadata(chunk));
      return { chunk, score: seedBoost + relationBoost + proximity + coverage };
    })
    .sort(
      (a, b) =>
        b.score - a.score || startOf(a.chunk) - startOf(b.chunk) || endOf(a.chunk) - endOf(b.chunk),
    )
    .slice(0, options.neighborTarget);
  if (!scored.some((item) => item.chunk.id === seed.id)) {
    scored.push({ chunk: seed, score: Number.MAX_SAFE_INTEGER });
  }
  const selectedIds = new Set(scored.map((item) => item.chunk.id));
  const ordered = chunks
    .filter((chunk) => selectedIds.has(chunk.id))
    .sort((a, b) => startOf(a) - startOf(b) || endOf(a) - endOf(b));
  const parts: string[] = [];
  const sourceChunkIds: string[] = [];
  const includedChunks: AdaptiveChunk[] = [];
  let totalLength = 0;
  for (const chunk of ordered) {
    if (totalLength >= options.maxContextChars) break;
    const remaining = options.maxContextChars - totalLength;
    const text = chunk.content.slice(0, remaining);
    parts.push(text);
    sourceChunkIds.push(chunk.id);
    includedChunks.push(chunk);
    totalLength += text.length + 2;
  }
  return {
    content: parts.join("\n\n"),
    startLine: Math.min(...includedChunks.map(startOf)),
    endLine: Math.max(...includedChunks.map(endOf)),
    sourceChunkIds,
  };
}

export function pushAdaptiveCandidate(candidates: RankedCandidate[], candidate: RankedCandidate): void {
  const overlappingIndex = candidates.findIndex(
    (existing) =>
      existing.chunk.kbId === candidate.chunk.kbId &&
      existing.chunk.filePath === candidate.chunk.filePath &&
      existing.sourceChunkIds.some((id) => candidate.sourceChunkIds.includes(id)),
  );
  if (overlappingIndex < 0) {
    candidates.push(candidate);
    return;
  }
  const existing = candidates[overlappingIndex];
  if (candidate.score > existing.score || candidate.sourceChunkIds.length > existing.sourceChunkIds.length) {
    candidates[overlappingIndex] = candidate;
  }
}
