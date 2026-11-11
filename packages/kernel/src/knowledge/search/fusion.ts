// 移植自 pi-knowledge@0.13.0 dist/src/search/fusion.js（MIT）
// 两路召回融合的两种方案：
// - reciprocalRankFusion：只看名次（score = Σ 1/(k + rank)），对分数尺度免疫；
// - weightedScoreFusion：min-max 归一后 0.45·BM25 + 0.55·向量 + 0.15·双路同时命中加成，
//   保留分数分布信息，让「词法与语义都强命中」的块明显排在「单路勉强命中」之前。
// 知识库检索走 weightedScoreFusion（见 search.ts）。min-max 会把各路最小值压成 0，
// 小库（2~5 条候选）里「次强命中」因此可能归零——这是对齐上游的已知取舍，不另改公式。
export interface FusionResult {
	chunkId: string;
	score: number;
}

function normalizeScores(list: FusionResult[]): Map<string, number> {
	if (list.length === 0) return new Map();
	const scores = list.map((item) => item.score);
	const min = Math.min(...scores);
	const max = Math.max(...scores);
	return new Map(
		list.map((item) => {
			const normalized = max === min ? 1 : (item.score - min) / (max - min);
			return [item.chunkId, normalized];
		}),
	);
}

export function reciprocalRankFusion(lists: FusionResult[][], k = 60): FusionResult[] {
	const scores = new Map<string, number>();
	for (const list of lists) {
		for (let rank = 0; rank < list.length; rank++) {
			const { chunkId } = list[rank];
			scores.set(chunkId, (scores.get(chunkId) ?? 0) + 1 / (k + rank + 1));
		}
	}
	return [...scores.entries()]
		.map(([chunkId, score]) => ({ chunkId, score }))
		.sort((a, b) => b.score - a.score);
}

export function weightedScoreFusion(
	bm25Results: FusionResult[],
	vectorResults: FusionResult[],
	weights = { bm25: 0.45, vector: 0.55, overlap: 0.15 },
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
