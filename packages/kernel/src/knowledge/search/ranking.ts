// 检索排序的质量层：置信门与词法证据门（移植自 pi-knowledge search/ranking.ts 的判定语义）。
// 目标：低分命中不再凑数——融合分低于门槛、或与查询几乎没有词法重叠的块不进结果。
import { bigram } from "../../memory/bigram";

/** 最低融合分（上游默认 0.18）：低于此分的命中即使排在前面也整体丢弃 */
export const MIN_HYBRID_SCORE = 0.18;

/** 单字与标点不算信号词（中文 bigram 里"的/了"类噪声不参与覆盖率） */
const STOP_CHARS = new Set(["的", "了", "是", "在", "和", "与", "或", "也", "都", "就"]);

/** 查询 token 集：bigram 切分后去掉纯标点与停用单字 */
export function queryTokensOf(query: string): Set<string> {
  const tokens = bigram(query).split(/\s+/).filter(Boolean);
  return new Set(tokens.filter((t) => !(t.length === 1 && STOP_CHARS.has(t))));
}

/** 信号词（用于判定"查询是否足够具体"）：去掉停用词后的 token */
export function signalTokens(tokens: Set<string>): Set<string> {
  return new Set([...tokens].filter((t) => !(t.length === 1 && STOP_CHARS.has(t))));
}

/** 查询 token 在文本中的命中比例（0~1） */
export function queryCoverage(text: string, queryTokens: Set<string>): number {
  if (queryTokens.size === 0) return 1;
  let hit = 0;
  for (const t of queryTokens) if (text.includes(t)) hit++;
  return hit / queryTokens.size;
}

/**
 * 词法证据门：与查询几乎没有词法重叠的块不进结果。
 * - 信号词 ≤1（短查询/单个术语）：直接放行（此时全靠语义通道）
 * - 信号词 ≤3：要求覆盖率达到 1/signals
 * - 更多信号词：要求覆盖率 ≥ 0.34（长问句允许部分重叠）
 */
export function hasEnoughLexicalEvidence(text: string, queryTokens: Set<string>): boolean {
  const signals = signalTokens(queryTokens);
  if (signals.size <= 1) return true;
  const coverage = queryCoverage(text, queryTokens);
  if (signals.size <= 3) return coverage >= 1 / signals.size;
  return coverage >= 0.34;
}
