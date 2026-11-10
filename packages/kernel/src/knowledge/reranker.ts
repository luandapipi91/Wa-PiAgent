// 深度重排（cross-encoder reranker）：把 (query, 块) 拼对过一遍模型打分。
// 与 embedding 模型（bi-encoder）不同：权重独立、必须按需下载；只在 deep 模式触发，
// 未就绪/失败时返回 null，调用方退化 hybrid（绝不报错、不阻断检索）。
// 模型管理沿用 memory/embedder 的 env 策略：WA_PI_MODEL_DIR 存在走本地目录（离线语义），
// 否则缓存落 WA_PI_DIR/models，首次加载由 transformers 自动从镜像下载。

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

/** tokenizer：支持 (text, { text_pair }) 成对编码 */
type RerankTokenizer = (
	text: string | string[],
	opts?: Record<string, unknown>,
) => Promise<unknown>;
/** 序列分类模型：返回 logits（dims: [batch, numLabels]） */
type RerankModel = (inputs: unknown) => Promise<{ logits: { data: Float32Array; dims: number[] } }>;

let pipe: { tokenizer: RerankTokenizer; model: RerankModel } | null = null;
let state: RerankerStatus = { status: "idle", model: RERANK_MODEL };
let loadPromise: Promise<boolean> | null = null;
let failNextLoad = false;

export function rerankerStatus(): RerankerStatus {
	return { ...state };
}

export function isRerankerReady(): boolean {
	return state.status === "ready" && pipe !== null;
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
			const { pipeline, env } = await import("@huggingface/transformers");
			if (!env.remoteHost || env.remoteHost.includes("huggingface.co")) {
				env.remoteHost = process.env.WA_PI_HF_ENDPOINT ?? "https://hf-mirror.com";
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
				AutoTokenizer: { from_pretrained: (m: string) => Promise<RerankTokenizer> };
				AutoModelForSequenceClassification: {
					from_pretrained: (m: string, o?: Record<string, unknown>) => Promise<RerankModel>;
				};
			};
			const tokenizer = await mod.AutoTokenizer.from_pretrained(RERANK_MODEL);
			const model = await mod.AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, {
				dtype: RERANK_DTYPE,
			});
			pipe = { tokenizer, model };
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
	state = { status: "idle", model: RERANK_MODEL };
}

/** 模型指纹（设置页/排障用）：与 embedding 指纹区分开 */
export function rerankerFingerprint(): string {
	return `rerank:${RERANK_MODEL}:${RERANK_DTYPE}`;
}
