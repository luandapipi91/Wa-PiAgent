// model-catalog-refresh.ts — 从 pi.dev 后台拉取最新模型目录（尽力而为，绝不影响系统）
//
// 为什么需要它：pi 自己会在启动/周期性从 pi.dev 拉模型目录（价格、上下文长度等），
// 结果存在 `<agent-dir>/models-store.json`，渲染 provider 时合并进内置目录。但 wa-pi
// 给 pi 子进程传了 `--offline`（关闭「子进程启动时的模型目录网络刷新」），所以这份数据
// 永远不会更新，模型参数停在安装那一刻。
//
// 本模块把「拉取」搬到 kernel：启动后**后台**拉一次，按 pi 的原生格式写进同一个
// models-store.json。于是两件事同时成立：
//   1. pi 子进程即便在 `--offline` 下也会读到并使用它——离线只挡「发请求」，
//      不挡「读取已落盘的数据」（`remote-catalog-provider.js` 的 restore 在 allowNetwork 判断之前）；
//   2. kernel 侧生成 provider-extension 时也能读到（见 pi-catalog.ts 的合并）。
//
// 上游契约（复刻来源：pi-coding-agent 1.0.0
//   `dist/core/remote-catalog-provider.js` 与 `dist/core/models-store.js`）：
//   · URL：`GET {base}/api/models/providers/<providerId>?types=chat,image,classifier`
//   · 落盘：`<agent-dir>/models-store.json` → `{ "<providerId>": { models, checkedAt, lastModified, etag } }`
//   · 单次请求 4s 超时；304 沿用旧 models；404/501 记 `lastModified: 0`（该 provider 无远程目录）；
//     其它失败保留原有 models 与 etag
//   · 合并进内置目录时，只有 `lastModified > 内置数据生成时间` 才生效（pi 的 localGeneratedAt 语义）
//
// 失败哲学：本模块**不抛错**。拉不到、超时、盘写不进去——全部静默降级为「用内置目录」，
// 与拉取之前的行为完全一致。任何一处 await 都不该拖慢启动（调用方自行决定不 await）。

/** pi 的目录服务地址（与上游同值） */
export const DEFAULT_CATALOG_BASE_URL = "https://pi.dev";
/** 单次目录请求的超时（与上游同值：4 秒） */
export const CATALOG_ATTEMPT_TIMEOUT_MS = 4_000;
/** 一次刷新里同时在飞的请求数上限（只拉用户实际用到的 provider，通常 1~3 个） */
export const CATALOG_MAX_CONCURRENCY = 4;
/** 要请求的模型类型（上游按此参数返回全量分片，而非只有 chat 的旧分片） */
export const CATALOG_MODEL_TYPES = ["chat", "image", "classifier"];

/** models-store.json 里单个 provider 的条目（与 pi 的 ModelsStoreEntry 同形） */
export interface CatalogStoreEntry {
	models: unknown[];
	checkedAt: number;
	lastModified: number;
	etag?: string;
}

/** models-store.json 的整份内容 */
export type CatalogStore = Record<string, CatalogStoreEntry>;

/** `<agent-dir>/models-store.json`：pi 的模型目录落盘位置 */
export function modelsStorePath(agentDir: string): string {
	return `${agentDir}/models-store.json`;
}

/**
 * 解析服务端返回的目录体（复刻 pi 的 `parseCatalog`）。
 *
 * 兼容三种形状：数组 / `{ models: [...] }` / 以 id 为键的对象；只保留「是对象且有 id」
 * 且类型受支持的条目，并补上 `provider` 字段（pi 后续按同一形状合并与比对）。
 * 形状不认识时抛错——由调用方当作「这次拉取失败」处理。
 */
export function parseCatalogPayload(providerId: string, value: unknown): unknown[] {
	const entries = Array.isArray(value)
		? value
		: value && typeof value === "object" && Array.isArray((value as { models?: unknown }).models)
			? (value as { models: unknown[] }).models
			: value && typeof value === "object"
				? Object.values(value as Record<string, unknown>)
				: undefined;
	if (!entries) throw new Error(`Invalid model catalog for provider "${providerId}"`);
	return entries
		.filter(
			(entry) =>
				typeof entry === "object" && entry !== null && "id" in (entry as object),
		)
		.map((entry) => {
			const model = entry as { type?: unknown; provider?: string };
			// 类型不在支持集内的一律丢弃：pi 也会丢，留着只会让两侧看到的目录不一致
			if (
				model.type !== undefined &&
				(typeof model.type !== "string" ||
					!CATALOG_MODEL_TYPES.includes(model.type))
			) {
				return null;
			}
			return { ...model, provider: providerId };
		})
		.filter((model): model is { provider: string } => model !== null);
}

/** 读整份 models-store.json；文件缺失/损坏/形状非法 → 空表（不抛错） */
export async function readModelsStore(agentDir: string): Promise<CatalogStore> {
	try {
		const raw = await Bun.file(modelsStorePath(agentDir)).json();
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
		const out: CatalogStore = {};
		for (const [providerId, entry] of Object.entries(raw as Record<string, unknown>)) {
			if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
			const e = entry as Partial<CatalogStoreEntry>;
			if (!Array.isArray(e.models)) continue;
			out[providerId] = {
				models: e.models,
				checkedAt: typeof e.checkedAt === "number" ? e.checkedAt : 0,
				lastModified: typeof e.lastModified === "number" ? e.lastModified : 0,
				...(typeof e.etag === "string" ? { etag: e.etag } : {}),
			};
		}
		return out;
	} catch {
		return {};
	}
}

/** 按路径串行化写盘（同一文件并发写会互相覆盖；与 mcp-file / mcp-trust 同做法） */
const writeQueues = new Map<string, Promise<unknown>>();

function serializeByPath<T>(path: string, task: () => Promise<T>): Promise<T> {
	const prev = writeQueues.get(path) ?? Promise.resolve();
	const next = prev.then(task, task);
	writeQueues.set(
		path,
		next.catch(() => {}),
	);
	return next;
}

/**
 * 写整份 models-store.json（原子：临时文件 + rename）。
 *
 * 用原子替换而非直接覆盖：pi 子进程可能正在读这个文件，半截 JSON 会让它整份目录落空。
 * 写失败不抛错——目录数据是「锦上添花」，写不进去就继续用内置目录。
 */
export async function writeModelsStore(
	agentDir: string,
	store: CatalogStore,
): Promise<boolean> {
	const path = modelsStorePath(agentDir);
	return serializeByPath(path, async () => {
		try {
			const fs = await import("node:fs/promises");
			// 目录必须已存在：agentDir 是应用数据目录（启动流程负责建），刷新模块
			// 不该凭空造出它（Bun.write 会自动 mkdir -p，所以先显式确认）
			await fs.stat(agentDir);
			const tmp = `${path}.tmp-${process.pid}`;
			await Bun.write(tmp, JSON.stringify(store, null, 2));
			// rename 而非复制：pi 子进程可能正在读这个文件，半截 JSON 会让它整份目录落空
			await fs.rename(tmp, path);
			return true;
		} catch {
			return false;
		}
	});
}

/** 单次拉取的结果 */
export type FetchOutcome =
	/** 拿到新目录（或 304：沿用旧条目） */
	| { kind: "ok"; entry: CatalogStoreEntry }
	/** 服务端明确表示「这个 provider 没有远程目录」（404/501） */
	| { kind: "absent"; entry: CatalogStoreEntry }
	/** 网络/超时/解析失败——保留旧数据 */
	| { kind: "error" };

/**
 * 拉一个 provider 的目录。
 *
 * 超时用 `AbortSignal.timeout`（4 秒，与上游同值）：慢的请求不该让后台任务挂着，
 * 更不该在关机时拖住进程。任何一种失败都返回 `error`，由调用方决定保留旧条目。
 */
export async function fetchProviderCatalog(
	providerId: string,
	opts: {
		baseUrl?: string;
		timeoutMs?: number;
		prev?: CatalogStoreEntry;
		/** 注入用（测试）；缺省用全局 fetch */
		fetchImpl?: typeof fetch;
		/** 注入用（测试）：替代 AbortSignal.timeout */
		signalImpl?: () => AbortSignal;
	} = {},
): Promise<FetchOutcome> {
	const base = (opts.baseUrl ?? DEFAULT_CATALOG_BASE_URL).replace(/\/+$/, "");
	const timeoutMs = opts.timeoutMs ?? CATALOG_ATTEMPT_TIMEOUT_MS;
	const doFetch = opts.fetchImpl ?? fetch;
	const makeSignal =
		opts.signalImpl ?? (() => AbortSignal.timeout(timeoutMs));
	const now = Date.now();
	try {
		const url = new URL(`/api/models/providers/${encodeURIComponent(providerId)}`, base);
		url.searchParams.set("types", CATALOG_MODEL_TYPES.join(","));
		// 只在上次真的拿到了目录体时带 etag：否则 304 会让覆盖层空掉
		// （与上游同一条防御：「a 304 can never leave the overlay empty」）
		const validator =
			opts.prev && opts.prev.models.length > 0 ? opts.prev.etag : undefined;
		const res = await doFetch(url, {
			headers: {
				accept: "application/json",
				"user-agent": "wa-pi",
				...(validator ? { "if-none-match": validator } : {}),
			},
			signal: makeSignal(),
		});
		if (res.status === 304 && opts.prev) {
			return { kind: "ok", entry: { ...opts.prev, checkedAt: now } };
		}
		if (res.status === 404 || res.status === 501) {
			return {
				kind: "absent",
				entry: {
					...(opts.prev ?? { models: [] }),
					checkedAt: now,
					lastModified: 0,
					etag: undefined,
				},
			};
		}
		if (!res.ok) return { kind: "error" };
		const models = parseCatalogPayload(providerId, await res.json());
		const lastModified = Date.parse(res.headers.get("last-modified") ?? "");
		return {
			kind: "ok",
			entry: {
				models,
				checkedAt: now,
				lastModified: Number.isNaN(lastModified) ? 0 : lastModified,
				etag: res.headers.get("etag") ?? undefined,
			},
		};
	} catch {
		return { kind: "error" };
	}
}

/** 一次刷新任务的结果（供日志与调用方判断要不要重新生成 provider-extension） */
export interface RefreshResult {
	/** 本轮实际尝试的 provider */
	providerIds: string[];
	/** 拉到「新东西」的 provider（models 或 lastModified 变过） */
	updated: string[];
	/** 拉取失败的 provider（保留旧条目） */
	failed: string[];
	/** models-store.json 是否被改写（true = 下游该考虑重新生成 provider-extension） */
	changed: boolean;
}

/**
 * 后台刷新一批 provider 的目录，把结果合并进 models-store.json。
 *
 * 语义（与 pi 落盘一致）：
 *   · 有更新才写盘；只是重新检查过（304）不写 → 文件 mtime 只在真变化时前进，
 *     这样「models-store.json 比 provider-extension 新」就等价于「目录数据变过」。
 *   · 拉取失败保留该 provider 的旧条目（不清空、不写盘）。
 *
 * 绝不抛错：任何异常都收敛成 `failed` 与 `changed:false`。
 */
export async function refreshModelCatalog(
	providerIds: string[],
	opts: {
		agentDir: string;
		baseUrl?: string;
		timeoutMs?: number;
		fetchImpl?: typeof fetch;
		signalImpl?: () => AbortSignal;
	},
): Promise<RefreshResult> {
	// 去重并剔除空值：同一个 slug 可能被多个 provider 用到
	const ids = [...new Set(providerIds.filter((id) => typeof id === "string" && id))];
	const result: RefreshResult = {
		providerIds: ids,
		updated: [],
		failed: [],
		changed: false,
	};
	if (ids.length === 0) return result;

	try {
		const store = await readModelsStore(opts.agentDir);
		let changed = false;

		// 限并发：目录请求是后台任务，不该一次打出几十个连接抢占带宽
		let cursor = 0;
		const worker = async (): Promise<void> => {
			while (cursor < ids.length) {
				const id = ids[cursor++];
				const prev = store[id];
				const outcome = await fetchProviderCatalog(id, {
					baseUrl: opts.baseUrl,
					timeoutMs: opts.timeoutMs,
					prev,
					fetchImpl: opts.fetchImpl,
					signalImpl: opts.signalImpl,
				});
				if (outcome.kind === "error") {
					result.failed.push(id);
					continue;
				}
				const next = outcome.entry;
				// 只有目录内容或上游修改时间真的变了才认作「更新」
				const isNew =
					!prev ||
					next.lastModified !== prev.lastModified ||
					JSON.stringify(next.models) !== JSON.stringify(prev.models);
				store[id] = next;
				if (isNew) {
					result.updated.push(id);
					changed = true;
				}
			}
		};
		const workers = Array.from(
			{ length: Math.min(CATALOG_MAX_CONCURRENCY, ids.length) },
			() => worker(),
		);
		await Promise.all(workers);

		if (changed) {
			result.changed = await writeModelsStore(opts.agentDir, store);
		}
		return result;
	} catch {
		// 连兜底都撞上了意外（例如注入的实现抛错）——仍然不打扰调用方
		return result;
	}
}

/**
 * 启动后的「拉目录 + （有变化时）重建 provider-extension」编排。
 *
 * `regenerate` 由调用方注入（通常是 `ensureProviderExtensionRegistered`），而不在这里
 * import 生成器——否则会形成 provider-extension → pi-catalog → 本模块 的循环依赖。
 *
 * 仅供调用方**不 await** 地执行（后台任务）：它把全部异常收敛成日志，调用点只看到
 * “启动了”。重建失败也不影响已生成的旧 extension（旧文件仍可用）。
 */
export async function refreshCatalogAndRegenerate(
	providerIds: string[],
	opts: {
		agentDir: string;
		/** 目录真的有变化时调用（重生成 provider-extension） */
		regenerate: () => Promise<void>;
		baseUrl?: string;
		timeoutMs?: number;
		fetchImpl?: typeof fetch;
		signalImpl?: () => AbortSignal;
	/** 日志器（测试可注入静默版本） */
		log?: (message: string) => void;
	},
): Promise<RefreshResult> {
	const log = opts.log ?? ((m: string) => console.log(m));
	let result: RefreshResult;
	try {
		result = await refreshModelCatalog(providerIds, {
			agentDir: opts.agentDir,
			baseUrl: opts.baseUrl,
			timeoutMs: opts.timeoutMs,
			fetchImpl: opts.fetchImpl,
			signalImpl: opts.signalImpl,
		});
	} catch {
		return { providerIds, updated: [], failed: providerIds, changed: false };
	}
	if (result.failed.length > 0) {
		// 失败不是错——离线、超时、服务端抽风都会走到这里，旧数据继续用
		log(`[catalog] 模型目录未更新（${result.failed.join("、")}），继续用现有数据`);
	}
	if (!result.changed) return result;
	log(`[catalog] 模型目录已更新：${result.updated.join("、")}`);
	try {
		await opts.regenerate();
	} catch (err) {
		// 重建失败不影响已生成的旧 extension（仍可用），下次启动会再试
		log(`[catalog] provider-extension 重建失败（旧文件仍生效）：${String(err)}`);
	}
	return result;
}
