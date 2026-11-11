// 深度重排（cross-encoder reranker）：把 (query, 块) 拼对过一遍模型打分。
// 与 embedding 模型（bi-encoder）不同：权重独立、必须按需下载；只在 deep 模式触发，
// 未就绪/失败时返回空结果，调用方退化 hybrid（不阻断检索）。
// 模型选择由上游配置层 PI_KNOWLEDGE_RERANKER*（见 search/reranker-config.ts）决定，
// 缺省 ms-marco MiniLM-L4 + q8；加载路径沿用 memory/embedder 的 env 策略：
// WA_PI_MODEL_DIR 存在走本地目录（离线语义），否则缓存落 WA_PI_DIR/models，
// 首次加载由 transformers 自动从镜像下载。

import { throwIfAborted } from "./search/contracts";
import {
	DEFAULT_RERANKER_REMOTE_HOST,
	DEFAULT_RERANKER_REMOTE_PATH_TEMPLATE,
	resolveRerankerConfig,
	type HfRerankerConfig,
} from "./search/reranker-config";
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
/** 当前（或上次尝试加载的）模型与精度：状态/错误文案/指纹都用它，不再写死 RERANK_MODEL */
let activeModel = RERANK_MODEL;
let activeDtype = RERANK_DTYPE;
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
	onProgress: ((ev: DownloadProgressEvent) => void) | undefined,
	config: HfRerankerConfig,
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
				model: activeModel,
				error: `reranker 模型加载失败（测试注入）`,
			};
			return false;
		}
		try {
			// 模型/修订/精度/下载源全部来自上游配置层（PI_KNOWLEDGE_RERANKER*），缺省即
			// RERANK_MODEL + q8 + WA_PI_HF_ENDPOINT 镜像；api provider 未实现，在这里就报错
			const config = resolveRerankerConfig();
			if (config.provider !== "hf") {
				throw new Error(
					`reranker provider "${config.provider}" 未支持：Wa-Pi 只实现本地 hf 重排`,
				);
			}
			activeModel = config.model;
			activeDtype = config.dtype ?? RERANK_DTYPE;
			state = { status: "downloading", model: activeModel, progress: 0 };
			// 下载进度：按文件聚合 loaded/total（tokenizer 与 model 两次下载合并成一个百分比），
			// 否则 UI 只会看到 0% 一直到加载完成（下载大文件时表现为「卡住」）
			const files: DownloadProgressMap = new Map();
			const onProgress = (ev: DownloadProgressEvent) => {
				if (state.status !== "downloading") return;
				state = {
					status: "downloading",
					model: activeModel,
					progress: aggregateDownloadProgress(files, ev),
				};
			};
			const loader = testLoader ?? defaultRerankerLoader;
			const pair = await loader(onProgress, config);
			pipe = pair;
			state = { status: "ready", model: activeModel };
			return true;
		} catch (err) {
			state = {
				status: "failed",
				model: activeModel,
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

/**
 * 临时把 transformers 的下载源指到重排配置，执行 fn 后还原。
 * `env` 是进程级全局（上游靠 model-worker 子进程隔离，Wa-Pi 单进程没有隔离）：不还原的话，
 * 一旦改为重排专用 host/模型 URL，随后 embedder 的旧守卫（跳过「非空且不含 huggingface.co」）
 * 会保留该 host，e5 就去错误的源拉模型。失败/抛错路径同样必须还原。
 *
 * 还原是「比较后写」：只改回仍是我们本次写入的值。窗口内别的模块（如 embedder）合法改写过
 * 就不动它——否则会把自己的旧值反向盖回去（lost update）。
 */
export async function withRerankerEnv<T>(
	config: HfRerankerConfig,
	fn: () => Promise<T>,
): Promise<T> {
	const { env } = await import("@huggingface/transformers");
	const prevRemoteHost = env.remoteHost;
	const prevRemotePathTemplate = env.remotePathTemplate;
	// remoteHost 与 remotePathTemplate 是直接字符串拼接：尾部斜杠必须补齐
	const host = config.remoteHost ?? DEFAULT_RERANKER_REMOTE_HOST;
	const mineHost = `${host.replace(/\/+$/, "")}/`;
	const mineTemplate = config.remotePathTemplate ?? DEFAULT_RERANKER_REMOTE_PATH_TEMPLATE;
	env.remoteHost = mineHost;
	env.remotePathTemplate = mineTemplate;
	try {
		return await fn();
	} finally {
		if (env.remoteHost === mineHost) env.remoteHost = prevRemoteHost;
		if (env.remotePathTemplate === mineTemplate)
			env.remotePathTemplate = prevRemotePathTemplate;
	}
}

/** 默认加载器：transformers 直连，模型/修订/精度/下载源均取自上游配置层 */
const defaultRerankerLoader: RerankerLoader = async (onProgress, config) =>
	withRerankerEnv(config, async () => {
		const { env } = await import("@huggingface/transformers");
		if (process.env.WA_PI_MODEL_DIR) {
			env.allowRemoteModels = false;
			env.localModelPath = process.env.WA_PI_MODEL_DIR;
		} else {
			const { modelCacheDir } = await import("../memory/embedder");
			env.cacheDir = modelCacheDir();
		}
		// 不用 pipeline("text-classification")：它的 softmax 对单 logit 的 cross-encoder 恒输出 1.0，
		// 且不透传 text_pair（对象数组会被当纯文本 tokenize）。这里直接持 tokenizer + 分类模型，
		// 打分恒走原始 logit（RAW_LOGITS=false 也只支持单 logit；多类输出由 scoreSingleRawLogit 报明确错误）。
		const mod = (await import("@huggingface/transformers")) as unknown as {
			AutoTokenizer: {
				from_pretrained: (m: string, o?: Record<string, unknown>) => Promise<RerankTokenizer>;
			};
			AutoModelForSequenceClassification: {
				from_pretrained: (m: string, o?: Record<string, unknown>) => Promise<RerankModel>;
			};
		};
		const opts = { progress_callback: onProgress, revision: config.revision };
		const tokenizer = await mod.AutoTokenizer.from_pretrained(config.model, opts);
		const model = await mod.AutoModelForSequenceClassification.from_pretrained(config.model, {
			...opts,
			dtype: config.dtype ?? RERANK_DTYPE,
		});
		return { tokenizer, model };
	});

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
	if (state.status === "failed") state = { status: "idle", model: activeModel };
	const p = await getPipeline();
	return p !== null;
}

/**
 * 上游签名 rerank(query, candidates, topK, signal)：逐条 (query, 正文) 打分，按分降序截断到 topK
 * （search.ts 的 deep 分支使用）。
 * - 复用进程内 tokenizer+model（Wa-Pi 没有 model worker 子进程），模型/修订/精度取自
 *   PI_KNOWLEDGE_RERANKER*（缺省 RERANK_MODEL + q8）
 * - 未就绪返回 []（不触发下载），调用方退化普通排序
 * - 配置/加载/推理任何错误一律 console.warn + 返回 []，绝不阻断检索（取消信号除外）
 */
export async function rerank(
	query: string,
	candidates: Array<{ chunkId: string; content: string }>,
	topK: number,
	signal?: AbortSignal,
): Promise<Array<{ chunkId: string; score: number }>> {
	if (candidates.length === 0) return [];
	try {
		const config = resolveRerankerConfig();
		if (config.provider !== "hf") {
			throw new Error(
				`reranker provider "${config.provider}" 未支持：Wa-Pi 只实现本地 hf 重排（未支持 HTTP API 重排）`,
			);
		}
		// 未就绪不触发加载：下载只由设置页「开启」显式触发（prepareReranker）
		if (!isRerankerReady()) return [];
		const p = pipe;
		if (!p) return [];
		// transformers.js v4 的 tokenizer 调用同步返回 BatchEncoding；共享类型只声明到 unknown，
		// 这里窄化到上游 RawLogitTokenizer 形状（运行时一致）
		const tokenizer = p.tokenizer as unknown as RawLogitTokenizer;
		const results: Array<{ chunkId: string; score: number }> = [];
		for (const candidate of candidates) {
			throwIfAborted(signal);
			const [scored] = await rerankWithSingleRawLogit(
				{ text: query, text_pair: candidate.content },
				tokenizer,
				p.model,
				activeModel,
			);
			results.push({ chunkId: candidate.chunkId, score: scored.score });
			// 逐条推理是同步重活：每完成一条让出一次事件循环，
			// 避免长候选列表（deep 30 条）把 SSE 心跳等宏任务饿死
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		results.sort((a, b) => b.score - a.score);
		return results.slice(0, topK);
	} catch (err) {
		// 取消要向上抛（否则检索会当成「没有重排」继续跑）
		if (signal?.aborted) throw err;
		state = {
			status: "failed",
			model: activeModel,
			error: `reranker 重排失败：${err instanceof Error ? err.message : String(err)}`,
		};
		console.warn("[knowledge] reranker 重排失败（deep 模式退化为普通排序）：", err);
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
	if (state.status === "ready") state = { status: "idle", model: activeModel };
}

/** 测试钩子：重置状态；failNextLoad 让下一次加载直接失败 */
export function resetRerankerForTest(opts: { failNextLoad?: boolean } = {}): void {
	pipe = null;
	loadPromise = null;
	failNextLoad = opts.failNextLoad === true;
	testLoader = null;
	activeModel = RERANK_MODEL;
	activeDtype = RERANK_DTYPE;
	state = { status: "idle", model: RERANK_MODEL };
}

/** 模型指纹（设置页/排障用）：与 embedding 指纹区分开 */
export function rerankerFingerprint(): string {
	return `rerank:${activeModel}:${activeDtype}`;
}
