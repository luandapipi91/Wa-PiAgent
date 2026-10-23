/**
 * 线上版本历史取数（内核代拉）。
 *
 * 背景：前端内置的 version-history.json 固定于打包时刻，旧版安装包看不到
 * 安装版与线上最新版之间那些版本的更新内容；浏览器直连 OSS 会被桶 CORS 拦，
 * 故由内核服务端拉取（服务端无跨域限制），前端走同源 /api。
 *
 * 缓存 6 小时；拉取失败返回旧缓存（过期但可用），无缓存返回空数组，绝不抛错。
 */

/** 线上版本历史地址（发版脚本 scripts/publish-oss.ts 上传到同一 key） */
export const VERSION_HISTORY_URL =
	"https://oss.wapiagent.top/releases/version-history.json";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8_000;

export interface VersionHistoryEntry {
	version: string;
	date: string;
	sections: Record<string, string[]>;
}

let cache: { at: number; entries: VersionHistoryEntry[] } | null = null;

/** 校验并过滤：只保留 version/date/sections 结构合法的条目 */
export function parseVersionHistory(raw: unknown): VersionHistoryEntry[] {
	if (!Array.isArray(raw)) return [];
	const out: VersionHistoryEntry[] = [];
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const e = item as Record<string, unknown>;
		if (typeof e.version !== "string" || typeof e.date !== "string") continue;
		if (!e.sections || typeof e.sections !== "object") continue;
		const sections: Record<string, string[]> = {};
		for (const [category, items] of Object.entries(
			e.sections as Record<string, unknown>,
		)) {
			if (!Array.isArray(items)) continue;
			const strings = items.filter((i): i is string => typeof i === "string");
			if (strings.length) sections[category] = strings;
		}
		if (!Object.keys(sections).length) continue;
		out.push({ version: e.version, date: e.date, sections });
	}
	return out;
}

/** 测试用：清空缓存 */
export function __resetVersionHistoryCacheForTest(): void {
	cache = null;
}

export async function getRemoteVersionHistory(opts?: {
	fetchImpl?: typeof fetch;
	now?: () => number;
	url?: string;
}): Promise<VersionHistoryEntry[]> {
	const now = opts?.now ?? Date.now;
	if (cache && now() - cache.at < CACHE_TTL_MS) return cache.entries;

	const fetchImpl = opts?.fetchImpl ?? fetch;
	const url = opts?.url ?? VERSION_HISTORY_URL;
	try {
		const res = await fetchImpl(url, {
			redirect: "follow",
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!res.ok) throw new Error(`HTTP ${res.status}`);
		const entries = parseVersionHistory(await res.json());
		if (!entries.length) throw new Error("空历史或结构非法");
		cache = { at: now(), entries };
		return entries;
	} catch (err) {
		console.warn(
			`[version-history] 拉取线上版本历史失败：${err instanceof Error ? err.message : String(err)}`,
		);
		return cache?.entries ?? [];
	}
}
