// 深度重排（cross-encoder reranker）：把 (query, 块) 拼对过一遍模型打分。
// 与 embedding 模型（bi-encoder）不同：权重独立、必须按需下载；只在 deep 模式触发，
// 未就绪/失败时返回 null，调用方退化 hybrid（绝不报错、不阻断检索）。
// 模型管理沿用 memory/embedder 的 env 策略：WA_PI_MODEL_DIR 存在走本地目录（离线语义），
// 否则缓存落 WA_PI_DIR/models，首次加载由 transformers 自动从镜像下载。

import { throwIfAborted } from "./search/contracts";
import { resolveRerankerConfig } from "./search/reranker-config";
import { rerankWithSingleRawLogit, type RawLogitTokenizer } from "./search/reranker-logits";

/** 默认 reranker 模型（上游默认）：ms-marco MiniLM-L4 cross-encoder，量化后体积很小 */
export const RERANK_MODEL = "Xenova/ms-marco-MiniLM-L-4-v2";
export const RERANK_DTYPE = "q8";

export type RerankerState = "idle" | "downloading" | "ready" | "failed";

export interface RerankerStatus {
	status: RerankerState;
	model: string;
	/** 下载/加载进度（0~100，仅在 downloading 时有意义） */
	progress?: number;
	error?: string;
}

/** tokenizer：支持 (text, { text_pair }) 成对编码（transformers.js v4 是同步返回 BatchEncoding） */
type RerankTokenizer = (
	text: string | string[],
	opts?: Record<string, unknown>,
) => unknown;
/** 序列分类模型：返回 logits（dims: [batch, numLabels]） */
type RerankModel = (inputs: unknown) => Promise<{ logits: { data: Float32Array; dims: number[] } }>;

let pipe: { tokenizer: RerankTokenizer; model: RerankModel } | null = null;
let state: RerankerStatus = { status: "idle", model: RERANK_MODEL };
let loadPromise: Promise<boolean> | null = null;
let failNextLoad = false;
/** 测试注入的加载器（避免联网） */
let testLoader: RerankerLoader | null = null;

export function rerankerStatus(): RerankerStatus {
	return { ...state };
}

export function isRerankerReady(): boolean {
	return state.status === "ready" && pipe !== null;
}

/** transformers 的下载进度事件（字段随版本略有差异，只取需要的） */
export interface DownloadProgressEvent {
	status?: string;
	file?: string;
	loaded?: number;
	total?: number;
}

/** 每个文件的下载进度累加器（file → {loaded,total}） */
export type DownloadProgressMap = Map<string, { loaded: number; total: number }>;

/**
 * 把 transformers 的进度事件聚合成一个 0~99 的百分比（纯函数，便于单测）。
 * 为什么不用事件自带的 progress：tokenizer 与 model 是两次独立下载，后者从 0% 重新开始，
 * 直接透传会让进度条先 100% 再跳回 0%；按「所有已见文件的 loaded/total 之和」算，整体单调。
 * 上限封 99：100% 只由「加载完成」这一事实给出，避免下载完了但 ONNX 还没就绪的假完成。
 */
export function aggregateDownloadProgress(
	files: DownloadProgressMap,
	ev: DownloadProgressEvent,
): number {
	const file = ev.file;
	if (file) {
		if (ev.status === "initiate") {
			if (!files.has(file)) files.set(file, { loaded: 0, total: 0 });
		} else if (ev.status === "done") {
			const cur = files.get(file) ?? { loaded: 0, total: 0 };
			const size = cur.total || cur.loaded;
			files.set(file, { loaded: size, total: size });
		} else if (typeof ev.loaded === "number" || typeof ev.total === "number") {
			files.set(file, { loaded: ev.loaded ?? 0, total: ev.total ?? 0 });
		}
	}
	let loaded = 0;
	let total = 0;
	for (const v of files.values()) {
		loaded += v.loaded;
		total += v.total;
	}
	if (total <= 0) return 0;
	return Math.min(99, Math.round((loaded / total) * 100));
}

type RerankerPair = { tokenizer: RerankTokenizer; model: RerankModel };
/** 加载器：默认走 transformers 真实下载；测试可注入 fake（不联网） */
export type RerankerLoader = (
	onProgress?: (ev: DownloadProgressEvent) => void,
) => Promise<RerankerPair>;

/** 测试钩子：替换加载器（null 恢复默认） */
export function setRerankerLoaderForTest(loader: RerankerLoader | null): void {
	testLoader = loader;
}

async function getPipeline(): Promise<{ tokenizer: RerankTokenizer; model: RerankModel } | null> {
	if (state.status === "failed") return null;
	if (pipe) return pipe;
	if (loadPromise) {
		await loadPromise;
		return pipe;
	}
	loadPromise = (async () => {
		if (failNextLoad) {
			failNextLoad = false;
			state = {
				status: "failed",
				model: RERANK_MODEL,
				error: `reranker 模型加载失败（测试注入）`,
			};
			return false;
		}
		state = { status: "downloading", model: RERANK_MODEL, progress: 0 };
		try {
			// 下载进度：按文件聚合 loaded/total（tokenizer 与 model 两次下载合并成一个百分比），
			// 否则 UI 只会看到 0% 一直到加载完成（下载大文件时表现为「卡住」）
			const files: DownloadProgressMap = new Map();
			const onProgress = (ev: DownloadProgressEvent) => {
				if (state.status !== "downloading") return;
				state = {
					status: "downloading",
					model: RERANK_MODEL,
					progress: aggregateDownloadProgress(files, ev),
				};
			};
			const loader = testLoader ?? defaultRerankerLoader;
			const pair = await loader(onProgress);
			pipe = pair;
			state = { status: "ready", model: RERANK_MODEL };
			return true;
		} catch (err) {
			state = {
				status: "failed",
				model: RERANK_MODEL,
				error: `reranker 模型加载失败：${err instanceof Error ? err.message : String(err)}`,
			};
			console.error("[knowledge] reranker 加载失败（deep 模式将退化为 hybrid）：", err);
			return false;
		}
	})();
	const ok = await loadPromise;
	loadPromise = null;
	return ok ? pipe : null;
}

/** 默认加载器：transformers 直连（镜像 endpoint 可配），把下载进度回调透传出去 */
const defaultRerankerLoader: RerankerLoader = async (onProgress) => {
	const { env } = await import("@huggingface/transformers");
	if (!env.remoteHost || env.remoteHost.includes("huggingface.co")) {
		// 注意尾部斜杠：remoteHost 是与 remotePathTemplate 直接字符串拼接的
		const endpoint = (process.env.WA_PI_HF_ENDPOINT ?? "https://hf-mirror.com").replace(/\/+$/, "");
		env.remoteHost = `${endpoint}/`;
		env.remotePathTemplate = "{model}/resolve/{revision}/";
	}
	if (process.env.WA_PI_MODEL_DIR) {
		env.allowRemoteModels = false;
		env.localModelPath = process.env.WA_PI_MODEL_DIR;
	} else {
		const { modelCacheDir } = await import("../memory/embedder");
		env.cacheDir = modelCacheDir();
	}
	// 不用 pipeline("text-classification")：它的 softmax 对单 logit 的 cross-encoder 恒输出 1.0，
	// 且不透传 text_pair（对象数组会被当纯文本 tokenize）。这里直接持 tokenizer + 分类模型。
	const mod = (await import("@huggingface/transformers")) as unknown as {
		AutoTokenizer: {
			from_pretrained: (m: string, o?: Record<string, unknown>) => Promise<RerankTokenizer>;
		};
		AutoModelForSequenceClassification: {
			from_pretrained: (m: string, o?: Record<string, unknown>) => Promise<RerankModel>;
		};
	};
	const opts = { progress_callback: onProgress };
	const tokenizer = await mod.AutoTokenizer.from_pretrained(RERANK_MODEL, opts);
	const model = await mod.AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, {
		...opts,
		dtype: RERANK_DTYPE,
	});
	return { tokenizer, model };
};

/** 预加载（设置页「开启」后调用）：触发首次下载/加载；失败只记录状态，不抛 */
/**
 * 失败后是否允许再次尝试加载：设置页「重试」按钮依赖它。
 * 只对 failed / idle 放行；downloading 已在加载中、ready 已可用，都无需重复触发。
 */
export function shouldRetryLoad(status: RerankerState): boolean {
	return status === "failed" || status === "idle";
}

export async function prepareReranker(): Promise<boolean> {
	if (state.status === "ready") return true;
	// 上一次失败不能把重试永久锁死：清掉 failed 后重新走加载路径
	if (state.status === "failed") state = { status: "idle", model: RERANK_MODEL };
	const p = await getPipeline();
	return p !== null;
}

/**
 * 对 (query, doc) 对打分：返回与 docs 等长的相关度分数（越高越相关）。
 * 未就绪/推理失败返回 null（调用方退化 hybrid）。
 */
export async function rerankScores(query: string, docs: string[]): Promise<number[] | null> {
	if (docs.length === 0) return [];
	// 未就绪不触发加载：下载只由设置页「开启」显式触发（prepareReranker），检索路径只消费已就绪的模型
	if (!isRerankerReady()) return null;
	const p = pipe;
	if (!p) return null;
	try {
		const batchSize = 16;
		const out: number[] = [];
		for (let i = 0; i < docs.length; i += batchSize) {
			const batch = docs.slice(i, i + batchSize);
			const inputs = await p.tokenizer(batch.map(() => query), {
				text_pair: batch,
				padding: true,
				truncation: true,
				max_length: 512,
			});
			const { logits } = await p.model(inputs);
			out.push(...parseRerankLogits(logits.data, logits.dims));
		}
		return out.slice(0, docs.length);
	} catch (err) {
		state = {
			status: "failed",
			model: RERANK_MODEL,
			error: `reranker 推理失败：${err instanceof Error ? err.message : String(err)}`,
		};
		return null;
	}
}

/**
 * 从 logits 解析每个样本的相关度分数（纯函数，便于单测）。
 * - 单 logit（cross-encoder 常见，如 ms-marco-MiniLM）：直接取原值（sigmoid 不改变排序）
 * - 多类（numLabels ≥ 2）：取最后一类的概率（softmax 近似：直接取该列 logit 也保序）
 */
export function parseRerankLogits(data: Float32Array, dims: number[]): number[] {
	const labels = dims.length >= 2 ? Math.max(1, dims[dims.length - 1]) : 1;
	const batch = labels > 0 ? Math.trunc(data.length / labels) : 0;
	const out: number[] = [];
	for (let i = 0; i < batch; i++) {
		out.push(labels === 1 ? data[i] : data[i * labels + (labels - 1)]);
	}
	return out;
}

/**
 * 上游签名 rerank(query, candidates, topK, signal)：逐条 (query, 正文) 打分，按分降序截断到 topK
 * （search.ts 的 deep 分支使用）。
 * - 复用进程内 tokenizer+model（Wa-Pi 没有 model worker 子进程）；模型仍是设置页管理的
 *   RERANK_MODEL，配置层只用来做 provider 分流
 * - 未就绪返回 []（同 rerankScores 的 null 约定），调用方退化普通排序
 * - PI_KNOWLEDGE_RERANKER=api:<model> 未实现：抛明确错误（Wa-Pi 不走 HTTP 重排 API）
 */
export async function rerank(
	query: string,
	candidates: Array<{ chunkId: string; content: string }>,
	topK: number,
	signal?: AbortSignal,
): Promise<Array<{ chunkId: string; score: number }>> {
	if (candidates.length === 0) return [];
	const config = resolveRerankerConfig();
	if (config.provider !== "hf") {
		throw new Error(
			`reranker provider "${config.provider}" 未支持：Wa-Pi 只实现本地 hf 重排（模型由设置页「深度重排」管理）`,
		);
	}
	// 未就绪不触发加载：下载只由设置页「开启」显式触发（同 rerankScores）
	if (!isRerankerReady()) return [];
	const p = pipe;
	if (!p) return [];
	// transformers.js v4 的 tokenizer 调用同步返回 BatchEncoding；共享类型按「可能异步」声明，
	// 这里窄化到上游 RawLogitTokenizer 形状（运行时一致）
	const tokenizer = p.tokenizer as unknown as RawLogitTokenizer;
	try {
		const results: Array<{ chunkId: string; score: number }> = [];
		for (const candidate of candidates) {
			throwIfAborted(signal);
			const [scored] = await rerankWithSingleRawLogit(
				{ text: query, text_pair: candidate.content },
				tokenizer,
				p.model,
				RERANK_MODEL,
			);
			results.push({ chunkId: candidate.chunkId, score: scored.score });
		}
		results.sort((a, b) => b.score - a.score);
		return results.slice(0, topK);
	} catch (err) {
		// 取消要向上抛（否则检索会当成「没有重排」继续跑）
		if (signal?.aborted) throw err;
		state = {
			status: "failed",
			model: RERANK_MODEL,
			error: `reranker 推理失败：${err instanceof Error ? err.message : String(err)}`,
		};
		return [];
	}
}

/** 卸载模型（设置页关闭开关时调用）：释放 ONNX session，不删缓存文件 */
export async function unloadReranker(): Promise<void> {
	const current = pipe as unknown as { model?: { dispose?: () => Promise<unknown> } } | null;
	try {
		await current?.model?.dispose?.();
	} catch (err) {
		console.warn("[knowledge] reranker dispose 失败（单例已置空，退回 GC 兜底）:", err);
	}
	pipe = null;
	if (state.status === "ready") state = { status: "idle", model: RERANK_MODEL };
}

/** 测试钩子：重置状态；failNextLoad 让下一次加载直接失败 */
export function resetRerankerForTest(opts: { failNextLoad?: boolean } = {}): void {
	pipe = null;
	loadPromise = null;
	failNextLoad = opts.failNextLoad === true;
	testLoader = null;
	state = { status: "idle", model: RERANK_MODEL };
}

/** 模型指纹（设置页/排障用）：与 embedding 指纹区分开 */
export function rerankerFingerprint(): string {
	return `rerank:${RERANK_MODEL}:${RERANK_DTYPE}`;
}
