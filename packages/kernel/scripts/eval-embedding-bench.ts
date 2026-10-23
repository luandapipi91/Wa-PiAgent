// embedding 模型评测基准：同口径对比多候选（task-3/task-4 POC 工具，不进权威测试入口——需下载模型）。
//
// 用法：
//   bun run scripts/eval-embedding-bench.ts                # 跑全部模型（含基线）
//   bun run scripts/eval-embedding-bench.ts --only m1,m3   # 只跑指定配置 id
//
// 评分口径：
//   - 相关查询：hit@1 / hit@3 / MRR（正例语料在 22 条语料中的排名）
//   - 负例查询：top-1 cos（应低）
//   - 区分度间隔 = 相关查询平均 top-1 cos − 负例平均 top-1 cos（判绝对阈值可用性）
import { pipeline, env } from "@huggingface/transformers";
import { CORPUS, QUERIES, type BenchQuery } from "./embedding-bench-data.ts";

// 与生产 embedder 相同的离线口径：允许 HF 镜像端点覆盖
if (process.env.WA_PI_HF_ENDPOINT) env.remoteHost = process.env.WA_PI_HF_ENDPOINT;

interface ModelConfig {
	id: string;
	model: string;
	dtype: "q8" | "fp32";
	pooling: "mean" | "cls";
	queryPrefix: string;
	passagePrefix: string;
	note: string;
}

const CONFIGS: ModelConfig[] = [
	{
		id: "baseline-bge-small-zh",
		model: "Xenova/bge-small-zh-v1.5",
		dtype: "q8",
		pooling: "mean",
		queryPrefix: "为这个句子生成表示以用于检索相关文章：",
		passagePrefix: "",
		note: "现状基线（生产口径：mean+normalize）",
	},
	{
		id: "bge-small-zh-cls",
		model: "Xenova/bge-small-zh-v1.5",
		dtype: "q8",
		pooling: "cls",
		queryPrefix: "为这个句子生成表示以用于检索相关文章：",
		passagePrefix: "",
		note: "基线的 CLS 口径对照（bge 官方推荐 [CLS]）",
	},
	{
		id: "m1-e5-small",
		model: "Xenova/multilingual-e5-small",
		dtype: "q8",
		pooling: "mean",
		queryPrefix: "query: ",
		passagePrefix: "passage: ",
		note: "multilingual-e5-small 118M/384 维/100+ 语言",
	},
	{
		id: "m2-bge-base-zh",
		model: "Xenova/bge-base-zh-v1.5",
		dtype: "q8",
		pooling: "cls",
		queryPrefix: "为这个句子生成表示以用于检索相关文章：",
		passagePrefix: "",
		note: "bge-base-zh 102M/768 维/纯中文对照",
	},
	{
		id: "m3-jina-zh",
		model: "Xenova/jina-embeddings-v2-base-zh",
		dtype: "q8",
		pooling: "mean",
		queryPrefix: "",
		passagePrefix: "",
		note: "jina-v2-base-zh 161M/768 维/中英双语",
	},
	{
		id: "m4-minilm",
		model: "Xenova/paraphrase-multilingual-MiniLM-L12-v2",
		dtype: "q8",
		pooling: "mean",
		queryPrefix: "",
		passagePrefix: "",
		note: "paraphrase-multilingual-MiniLM 118M/384 维/50+ 语言（下限对照）",
	},
];

function cosine(a: Float32Array | number[], b: Float32Array | number[]): number {
	let dot = 0, na = 0, nb = 0;
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) { dot += (a[i] as number) * (b[i] as number); na += (a[i] as number) ** 2; nb += (b[i] as number) ** 2; }
	return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

interface BenchResult {
	configId: string;
	hit1: number;
	hit3: number;
	mrr: number;
	posTop1Avg: number;
	negTop1Avg: number;
	margin: number;
	/** 相关查询的逐条明细 */
	details: Array<{ qid: string; rank: number; cos: number }>;
}

async function runConfig(cfg: ModelConfig): Promise<BenchResult> {
	console.log(`\n▶ [${cfg.id}] ${cfg.model}（${cfg.note}）`);
	const extractor = await pipeline("feature-extraction", cfg.model, { dtype: cfg.dtype });

	const encode = async (text: string, prefix: string): Promise<Float32Array> => {
		const out = await extractor(prefix + text, { pooling: cfg.pooling, normalize: true });
		return out.data as Float32Array;
	};

	// 语料向量（passage 口径）
	const corpusVecs = new Map<string, Float32Array>();
	for (const c of CORPUS) corpusVecs.set(c.id, await encode(c.text, cfg.passagePrefix));

	let hit1 = 0, hit3 = 0, rrSum = 0;
	const posDetails: BenchResult["details"] = [];
	const posTop1s: number[] = [];
	const relevantQueries = QUERIES.filter((q) => q.relevant);
	for (const q of relevantQueries) {
		const qv = await encode(q.text, cfg.queryPrefix);
		const scored = CORPUS.map((c) => ({ id: c.id, cos: cosine(qv, corpusVecs.get(c.id)!) }))
			.sort((a, b) => b.cos - a.cos);
		const rank = scored.findIndex((s) => s.id === q.expectedId) + 1;
		const top1 = scored[0];
		if (rank === 1) hit1++;
		if (rank >= 1 && rank <= 3) hit3++;
		rrSum += rank > 0 ? 1 / rank : 0;
		posTop1s.push(top1.cos);
		posDetails.push({ qid: q.id, rank, cos: top1.cos });
		console.log(
			`  [${q.id}] "${q.text.slice(0, 24)}" → 正例排名 #${rank}（top-1=${top1.id} cos=${top1.cos.toFixed(4)}）`,
		);
	}

	const negTop1s: number[] = [];
	for (const q of QUERIES.filter((x: BenchQuery) => !x.relevant)) {
		const qv = await encode(q.text, cfg.queryPrefix);
		const scored = CORPUS.map((c) => ({ id: c.id, cos: cosine(qv, corpusVecs.get(c.id)!) }))
			.sort((a, b) => b.cos - a.cos);
		negTop1s.push(scored[0].cos);
		console.log(`  [${q.id}] 负例 "${q.text.slice(0, 24)}" → top-1 cos=${scored[0].cos.toFixed(4)}（${scored[0].id}）`);
	}

	const n = relevantQueries.length;
	const posTop1Avg = posTop1s.reduce((a, b) => a + b, 0) / n;
	const negTop1Avg = negTop1s.reduce((a, b) => a + b, 0) / negTop1s.length;
	return {
		configId: cfg.id,
		hit1: hit1 / n,
		hit3: hit3 / n,
		mrr: rrSum / n,
		posTop1Avg,
		negTop1Avg,
		margin: posTop1Avg - negTop1Avg,
		details: posDetails,
	};
}

const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const only = onlyArg ? onlyArg.split("=")[1].split(",") : null;
const selected = only ? CONFIGS.filter((c) => only.includes(c.id)) : CONFIGS;

const results: BenchResult[] = [];
for (const cfg of selected) {
	try {
		results.push(await runConfig(cfg));
	} catch (err) {
		console.error(`✗ [${cfg.id}] 失败：`, err);
	}
}

console.log("\n════════ 汇总（语料 21 条 / 相关查询 11 / 负例 2）════════");
console.log("configId".padEnd(24) + "hit@1   hit@3   MRR     相关top1  负例top1  区分度间隔");
for (const r of results) {
	console.log(
		r.configId.padEnd(24) +
			`${r.hit1.toFixed(2)}    ${r.hit3.toFixed(2)}    ${r.mrr.toFixed(3)}   ` +
			`${r.posTop1Avg.toFixed(4)}   ${r.negTop1Avg.toFixed(4)}    ${r.margin >= 0 ? "+" : ""}${r.margin.toFixed(4)}`,
	);
}
console.log("\n区分度间隔 = 相关查询平均 top-1 cos − 负例平均 top-1 cos：");
console.log("间隔越大，绝对阈值（如 0.8 距离门槛）越可用；±0.01 级 = 阈值无判别力。");
