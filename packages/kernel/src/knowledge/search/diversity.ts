// 检索结果多样性：MMR 去重（近似重复块只留一条）+ 按文件交错（单文件最多 N 条）。
// 目的：不要一个文件霸榜——同一文档的相邻块内容高度相似，占满 limit 会让答案缺少别的来源。
import { bigram } from "../../memory/bigram";

/** 近似重复阈值：bigram Jaccard ≥ 0.85 视为重复 */
export const DUP_JACCARD = 0.85;

function jaccard(a: string, b: string): number {
  const sa = new Set(bigram(a).split(/\s+/).filter(Boolean));
  const sb = new Set(bigram(b).split(/\s+/).filter(Boolean));
  if (sa.size === 0 && sb.size === 0) return 1;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * MMR 选择：每步在未选集合里挑 `lambda * 相关度 - (1-lambda) * 与已选的最大相似度` 最高者。
 * 相关度用 min-max 归一后的分数（与已选集合的相似度用 bigram Jaccard）。
 */
export function mmrSelect<T extends { score: number; content: string }>(
  items: T[],
  opts: { limit: number; lambda: number },
): T[] {
  if (items.length === 0 || opts.limit <= 0) return [];
  const scores = items.map((i) => i.score);
  const max = Math.max(...scores);
  const min = Math.min(...scores);
  const rel = (s: number) => (max === min ? 1 : (s - min) / (max - min));
  const selected: T[] = [];
  const rest = [...items];
  while (selected.length < opts.limit && rest.length > 0) {
    let bestIdx = 0;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < rest.length; i++) {
      const maxSim = selected.length === 0
        ? 0
        : Math.max(...selected.map((s) => jaccard(rest[i].content, s.content)));
      const mmr = opts.lambda * rel(rest[i].score) - (1 - opts.lambda) * maxSim;
      if (mmr > bestScore) {
        bestScore = mmr;
        bestIdx = i;
      }
    }
    selected.push(rest.splice(bestIdx, 1)[0]);
  }
  return selected;
}

/**
 * 按文件交错：按顺序轮转取各文件的条目，单文件超出 maxPerFile 的丢弃。
 * 保留原有相对顺序（同文件内按分数高→低）。
 */
export function interleaveByFile<T extends { filePath: string }>(items: T[], maxPerFile = 2): T[] {
  const byFile = new Map<string, T[]>();
  for (const item of items) {
    const list = byFile.get(item.filePath) ?? [];
    list.push(item);
    byFile.set(item.filePath, list);
  }
  const out: T[] = [];
  const cursors = new Map<string, number>();
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const [file, list] of byFile) {
      const idx = cursors.get(file) ?? 0;
      if (idx >= list.length || idx >= maxPerFile) continue;
      out.push(list[idx]);
      cursors.set(file, idx + 1);
      progressed = true;
    }
  }
  return out;
}

/**
 * 组合入口：先按分数降序做「近似重复剔除」（与已保留项 Jaccard ≥ 0.85 即跳过），
 * 再按文件交错，最后截断到 limit。
 * 说明：纯 MMR（lambda=0.7）在「两者分数都很高」时仍会选中相似项（rel 接近 1、惩罚不足），
 * 因此重复判定用显式阈值；mmrSelect 保留给需要平滑加权的场景。
 */
export function diversify<T extends { score: number; filePath: string; content: string }>(
  items: T[],
  opts: { limit: number; maxPerFile: number; lambda: number },
): T[] {
  const sorted = [...items].sort((a, b) => b.score - a.score);
  const kept: T[] = [];
  for (const item of sorted) {
    if (kept.some((k) => jaccard(item.content, k.content) >= DUP_JACCARD)) continue;
    kept.push(item);
  }
  return interleaveByFile(kept, opts.maxPerFile).slice(0, opts.limit);
}
