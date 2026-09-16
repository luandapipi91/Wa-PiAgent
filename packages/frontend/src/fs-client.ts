// 把 fs 系列 REST 调用封装成 Promise，供 react-complex-tree DataProvider 异步调用。
import i18n from "./i18n";
import { api } from "./api-client";
import type { DirEntry } from "@wa-pi/shared";
import { KernelError } from "@wa-pi/shared";
import { formatKernelError } from "./util/kernel-error";

/**
 * 底层传输抽象。默认走真实 api-client；单测可通过 `_setFsTransport` 注入伪传输，
 * 避免 bun `mock.module` 跨文件缓存污染。
 */
export interface FsTransport {
	get: (path: string) => Promise<unknown>;
	post: (path: string, body?: unknown) => Promise<unknown>;
	del: (path: string, body?: unknown) => Promise<unknown>;
}

const defaultTransport: FsTransport = {
	get: (path) => api.get(path),
	post: (path, body) => api.post(path, body),
	del: (path, body) => api.del(path, body),
};
let transport: FsTransport = defaultTransport;

/** 测试注入传输层；传 null 恢复默认（真实 api-client）。 */
export function _setFsTransport(t: FsTransport | null): void {
	transport = t ?? defaultTransport;
}

export async function getHome(): Promise<string> {
	const res = (await transport.get("/api/fs/home")) as { home: string };
	return res.home;
}

export async function getRoots(): Promise<string[]> {
	const res = (await transport.get("/api/fs/roots")) as { roots: string[] };
	return res.roots;
}

// ── 目录列表 / 存在性探测的「在途去重 + 短 TTL 缓存」──
//
// 为什么要做：这两类请求是消息/文件树高频路径（ExplorerPanel 每 5s 轮询已展开目录、
// 每条消息里每个路径 chip 各探测一次、虚拟滚动滚回视口会重挂载重发）。没有去重时，
// 同一路径会在同一时刻被重复请求，批量返回时集中 setState 造成界面卡顿。
//
// 两级策略：
// - listDir：只做**在途去重**（同路径并发合并为一个请求），不缓存结果——目录内容随时会变，
//   缓存会让「点击展开」「轮询刷新」拿到过期列表。
// - stat：幂等的存在性查询，除在途去重外再加 3s TTL 缓存（吸收虚拟滚动重挂载的重复探测）。
const STAT_TTL_MS = 3000;
const inflightListDir = new Map<string, Promise<DirEntry[]>>();
const statCache = new Map<string, { at: number; exists: boolean }>();

/** 清空 fs 查询状态（测试用；也让写操作后可主动失效）。
 *  必须连同批调度器状态一起复位：残留的 scheduled=true 会让后续调用只入队、永不 flush，
 *  Promise 永久挂起（表现为 chip 永远停在“探测中”）。 */
export function _clearFsQueryCache(): void {
	inflightListDir.clear();
	statCache.clear();
	pendingStatPaths = [];
	pendingStatResolvers = [];
	statFlushScheduled = false;
}

export async function listDir(
	path: string,
	showHidden?: boolean,
): Promise<DirEntry[]> {
	const key = `${showHidden ? 1 : 0}\u0000${path}`;
	const inflight = inflightListDir.get(key);
	if (inflight) return inflight;

	const task = (async () => {
		try {
			const res = (await transport.post("/api/fs/list-dir", {
				path,
				showHidden,
			})) as { entries?: DirEntry[] };
			return res.entries ?? [];
		} finally {
			inflightListDir.delete(key);
		}
	})();
	inflightListDir.set(key, task);
	return task;
}

/** 批量存在性探测：一次 HTTP 拿多个路径（未知/失败项按不存在处理） */
export async function statFiles(
	paths: string[],
): Promise<Map<string, boolean>> {
	const out = new Map<string, boolean>();
	const need: string[] = [];
	const now = Date.now();
	for (const p of paths) {
		if (out.has(p) || need.includes(p)) continue;
		const cached = statCache.get(p);
		if (cached && now - cached.at < STAT_TTL_MS) out.set(p, cached.exists);
		else need.push(p);
	}
	if (need.length === 0) return out;

	const res = (await transport.post("/api/fs/stat-batch", {
		paths: need,
	})) as { results?: { path: string; exists?: boolean }[] };
	for (const r of res.results ?? []) {
		const exists = r.exists === true;
		out.set(r.path, exists);
		statCache.set(r.path, { at: Date.now(), exists });
	}
	for (const p of need) if (!out.has(p)) out.set(p, false);
	return out;
}

// 同一次事件循环内的多次探测合并为一个请求：一条消息里 N 个路径 chip 各自挂载时
// 会各调一次，这里攒到下一个 tick 一起发（从 N 次请求降到 1 次）。
let pendingStatPaths: string[] = [];
let pendingStatResolvers: ((m: Map<string, boolean>) => void)[] = [];
let statFlushScheduled = false;

/** 批量调度的存在性探测：同一 tick 内的多次调用自动合并为一个 HTTP 请求 */
export function statFilesBatched(
	paths: string[],
): Promise<Map<string, boolean>> {
	return new Promise((resolve) => {
		pendingStatPaths.push(...paths);
		pendingStatResolvers.push(resolve);
		if (statFlushScheduled) return;
		statFlushScheduled = true;
		// 用微任务而非 setTimeout：批窗口只需覆盖「同一次 React 提交里挂载的多个 chip」
		// （它们的 useEffect 在同一批次同步执行），微任务既够快也不受定时器环境影响——
		// 用 setTimeout 时在负载高的环境下曾出现回调迟迟不触发、Promise 挂起。
		queueMicrotask(() => {
			const batch = [...new Set(pendingStatPaths)];
			const resolvers = pendingStatResolvers;
			pendingStatPaths = [];
			pendingStatResolvers = [];
			statFlushScheduled = false;
			statFiles(batch)
				.then((m) => {
					for (const r of resolvers) r(m);
				})
				.catch(() => {
					for (const r of resolvers) r(new Map());
				});
		});
	});
}

/** 轻量文件存在性探测（不读内容），供 FilePill 挂载校验（走缓存） */
export async function statFile(path: string): Promise<boolean> {
	const m = await statFiles([path]);
	return m.get(path) === true;
}

export async function readFile(path: string): Promise<{
	content: string;
	mimeType?: string;
	resolvedPath?: string;
	unsupported?: string;
}> {
	const res = (await transport.post("/api/fs/read-file", { path })) as {
		content: string;
		mimeType?: string;
		resolvedPath?: string;
		reason?: string;
		code?: string;
		params?: Record<string, string | number>;
		type?: string;
	};
	if (res.type === "fs:unsupported")
		return {
			content: "",
			// code 化错误（attachment.*）按 kernelMsg 字典渲染；无 code（旧通道）reason 原样兜底
			unsupported:
				formatKernelError({
					code: res.code,
					params: res.params,
					message: res.reason,
				}).main || i18n.t("store.unsupportedPreview"),
		};
	if (!res.content) throw new Error(res.reason ?? i18n.t("store.readFailed"));
	return {
		content: res.content,
		mimeType: res.mimeType,
		resolvedPath: res.resolvedPath,
	};
}

/** 在系统文件管理器中打开文件所在目录 */
export async function revealFile(path: string): Promise<void> {
	await transport.post("/api/fs/reveal-file", { path });
}

/** 用系统默认应用打开文件本身（等同双击，macOS open / Windows start / Linux xdg-open） */
export async function openFileWithDefaultApp(path: string): Promise<void> {
	await transport.post("/api/fs/open-with-default-app", { path });
}

export async function copyToUploads(
	projectId: string,
	source: string,
	sessionId?: string,
): Promise<{ path: string }> {
	const res = (await transport.post("/api/fs/copy", {
		projectId,
		source,
		sessionId,
	})) as { path: string; error?: string };
	if (!res.path) throw new Error(res.error ?? i18n.t("store.copyFailedShort"));
	return { path: res.path };
}

export async function uploadFile(
	projectId: string,
	name: string,
	file: Blob,
	sessionId?: string,
): Promise<{ path: string }> {
	const form = new FormData();
	form.append("file", new File([file], name));
	const url = sessionId
		? `/api/files/upload?projectId=${encodeURIComponent(projectId)}&sessionId=${encodeURIComponent(sessionId)}`
		: `/api/files/upload?projectId=${encodeURIComponent(projectId)}`;
	const res = await fetch(url, { method: "POST", body: form });
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		// code 化错误（attachment.tooLarge）抛 KernelError：上层 formatKernelError 按字典渲染；
		// 与 api-client 同策略：优先 read 嵌套 failure，回退顶层 code/params（兼容旧形态）
		const failure =
			data?.failure ??
			(data?.code ? { code: data.code, params: data.params } : undefined);
		if (failure) throw new KernelError(failure.code, failure.params);
		throw new Error(data.error ?? `${res.status}`);
	}
	return { path: data.path };
}

export async function searchFiles(
	query: string,
	opts: {
		root?: string;
		maxResults?: number;
		showHidden?: boolean;
		onlyDirs?: boolean;
	} = {},
): Promise<{
	query: string;
	matches: { name: string; isDir: boolean; path: string }[];
	durationMs: number;
	truncated: boolean;
}> {
	const res = (await transport.post("/api/fs/search", {
		query,
		...opts,
	})) as any;
	return res;
}

export interface SearchMatch {
	name: string;
	isDir: boolean;
	path: string;
}

export interface SearchStreamHandlers {
	onProgress: (matches: SearchMatch[]) => void;
	onDone: (result: { durationMs: number; truncated: boolean }) => void;
}

export function searchFilesStream(
	query: string,
	opts: {
		roots: string[];
		maxResults?: number;
		showHidden?: boolean;
		onlyDirs?: boolean;
	},
	handlers: SearchStreamHandlers,
): () => void {
	const requests =
		opts.roots.length > 0
			? opts.roots.map((root) => ({ root, requestId: crypto.randomUUID() }))
			: [
					{
						root: undefined as string | undefined,
						requestId: crypto.randomUUID(),
					},
				];
	const pending = new Set(requests.map((r) => r.requestId));
	let totalDuration = 0;
	let anyTruncated = false;
	let cleaned = false;

	// SSE 进度监听：通过 events.ts 的 onMessage 注入，但 fs-client 不直接依赖 events
	// 这里用动态 import 避免循环依赖，单测可 mock
	let off: (() => void) | null = null;
	const cleanup = () => {
		if (cleaned) return;
		cleaned = true;
		off?.();
	};

	import("./events").then(({ onMessage }) => {
		if (cleaned) return;
		off = onMessage((e: any) => {
			if (cleaned) return;
			if (e.type === "fs:search:progress" && pending.has(e.requestId)) {
				handlers.onProgress(e.matches);
			} else if (e.type === "fs:search" && pending.has(e.requestId)) {
				if (e.matches?.length) handlers.onProgress(e.matches);
				pending.delete(e.requestId);
				totalDuration += e.durationMs;
				if (e.truncated) anyTruncated = true;
				if (pending.size === 0) {
					handlers.onDone({
						durationMs: totalDuration,
						truncated: anyTruncated,
					});
					cleanup();
				}
			}
		});
	});

	for (const r of requests) {
		void transport.post("/api/fs/search", {
			query,
			root: r.root,
			maxResults: opts.maxResults,
			showHidden: opts.showHidden,
			onlyDirs: opts.onlyDirs,
			requestId: r.requestId,
		});
	}

	return () => {
		cleanup();
		for (const r of requests) {
			void transport.post("/api/fs/search/cancel", { requestId: r.requestId });
		}
	};
}

export async function appendRecording(
	projectId: string,
	recId: string,
	chunk: string,
	sessionId?: string,
): Promise<void> {
	const res = (await transport.post("/api/files/recording/append", {
		projectId,
		recId,
		chunk,
		sessionId,
	})) as { error?: string };
	if (res.error) throw new Error(res.error);
}

export async function finalizeRecording(
	projectId: string,
	recId: string,
	finalName: string,
	sessionId?: string,
): Promise<{ path: string }> {
	const res = (await transport.post("/api/files/recording/finalize", {
		projectId,
		recId,
		finalName,
		sessionId,
	})) as { path: string; error?: string };
	if (!res.path) throw new Error(res.error ?? "finalize 失败");
	return { path: res.path };
}

export async function discardRecording(
	projectId: string,
	recId: string,
	sessionId?: string,
): Promise<void> {
	await transport.post("/api/files/recording/discard", {
		projectId,
		recId,
		sessionId,
	});
}

/** 把附件绝对路径转成可被 <audio>/<img> 直接加载的 kernel /file URL。 */
export function pathToUploadUrl(absPath: string): string {
	return "/file?path=" + encodeURIComponent(absPath);
}
