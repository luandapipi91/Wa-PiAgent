// 库内两路融合：min-max 归一后加权求和（移植自 pi-knowledge search/fusion.ts）。
// 与 RRF 的区别：RRF 只看名次、对分数尺度免疫；加权融合保留分数分布信息，
// 让「词法与语义都强命中」的块明显排在「单路勉强命中」之前（overlap 加成）。
export interface FusionResult {
	chunkId: string;
	score: number;
}

/** 权重取自上游默认值：BM25 0.45 / 向量 0.55 / 双路同时命中的加成 0.15 */
export const FUSION_WEIGHTS = { bm25: 0.45, vector: 0.55, overlap: 0.15 };

/**
 * 相对强度归一（score / max）：空列表返回空 Map，非正最大值一律归 0。
 * 不用 min-max 的原因：知识库常见小库（2~5 条候选），min-max 会把「次强命中」压成 0，
 * 与 0.18 置信门叠加后只剩一条结果；相对强度保留名次差距又不把第二名判成零相关。
 */
export function normalizeScores(list: FusionResult[]): Map<string, number> {
	if (list.length === 0) return new Map();
	const max = Math.max(...list.map((item) => item.score));
	if (max <= 0) return new Map(list.map((item) => [item.chunkId, 0]));
	return new Map(list.map((item) => [item.chunkId, item.score / max]));
}

/**
 * 加权分数融合：两路各自归一后加权求和，双路都为正（归一后）时再加 overlap。
 * 返回按融合分降序排列的候选（未截断）。
 */
export function weightedScoreFusion(
	bm25Results: FusionResult[],
	vectorResults: FusionResult[],
	weights = FUSION_WEIGHTS,
): FusionResult[] {
	const bm25Scores = normalizeScores(bm25Results);
	const vectorScores = normalizeScores(vectorResults);
	const ids = new Set([...bm25Scores.keys(), ...vectorScores.keys()]);
	const fused: FusionResult[] = [];
	for (const chunkId of ids) {
		const bm25 = bm25Scores.get(chunkId) ?? 0;
		const vector = vectorScores.get(chunkId) ?? 0;
		const overlap = bm25 > 0 && vector > 0 ? weights.overlap : 0;
		fused.push({ chunkId, score: weights.bm25 * bm25 + weights.vector * vector + overlap });
	}
	return fused.sort((a, b) => b.score - a.score);
}
