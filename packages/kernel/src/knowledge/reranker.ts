// 深度重排（cross-encoder reranker）：把 (query, 块) 拼对过一遍模型打分。
// 与 embedding 模型（bi-encoder）不同：权重独立、必须按需下载；只在 deep 模式触发，
// 未就绪/失败时返回 null，调用方退化 hybrid（绝不报错、不阻断检索）。
// 模型管理沿用 memory/embedder 的 env 策略：WA_PI_MODEL_DIR 存在走本地目录（离线语义），
// 否则缓存落 WA_PI_DIR/models，首次加载由 transformers 自动从镜像下载。
import { embedFingerprint } from "../memory/embedder";

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

type RerankPipeline = (
	inputs: Array<{ text: string; text_pair: string }>,
	opts?: Record<string, unknown>,
) => Promise<Array<{ score?: number; label?: string }> | Array<Array<{ score?: number; label?: string }>>>;

let pipe: RerankPipeline | null = null;
let state: RerankerStatus = { status: "idle", model: RERANK_MODEL };
let loadPromise: Promise<boolean> | null = null;
let failNextLoad = false;

export function rerankerStatus(): RerankerStatus {
	return { ...state };
}

export function isRerankerReady(): boolean {
	return state.status === "ready" && pipe !== null;
}

async function getPipeline(): Promise<RerankPipeline | null> {
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
			// progress_callback 用于把下载进度透出到设置页
			const created = (await pipeline("text-classification", RERANK_MODEL, {
				dtype: RERANK_DTYPE,
				device: "cpu",
				progress_callback: (p: { status?: string; progress?: number }) => {
					if (p?.progress !== undefined) {
						state = { status: "downloading", model: RERANK_MODEL, progress: Math.round(p.progress) };
					}
				},
			})) as unknown as RerankPipeline;
			pipe = created;
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
export async function prepareReranker(): Promise<boolean> {
	if (state.status === "ready") return true;
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
			const res = await p(batch.map((d) => ({ text: query, text_pair: d })));
			const flat = (Array.isArray(res) && Array.isArray(res[0]) ? res.flat() : res) as Array<{
				score?: number;
				label?: string;
			}>;
			// 部分模型输出多标签（label 0/1）：取 label="1" 的分数；二分类默认取最高分作为相关度
			for (const item of flat) {
				out.push(typeof item.score === "number" ? item.score : 0);
			}
			if (flat.length > batch.length) out.length = out.length - (flat.length - batch.length);
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
	return `rerank:${RERANK_MODEL}:${RERANK_DTYPE}:${embedFingerprint().length}`;
}
