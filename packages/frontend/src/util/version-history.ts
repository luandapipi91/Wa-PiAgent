/**
 * 版本历史纯函数：版本号比较、多来源合并、更新区间筛选、分类配色、localStorage 缓存。
 *
 * 数据有三个来源，优先级由低到高：
 *   1. bundled：打包进应用的 version-history.json（安装版固定于打包时刻）
 *   2. cache：localStorage 里上次拉到的线上数据（离线也能看到较新的历史）
 *   3. remote：内核代拉回来的线上数据
 */

export interface VersionEntry {
	version: string;
	date: string;
	/** 各版本 sections 键分布不一（新增/优化/修复/改进组合不同），允许缺键为 undefined */
	sections: Record<string, string[] | undefined>;
}

/** 历史列表最多展示的版本数（最新在前） */
export const MAX_VERSION_ENTRIES = 100;

/** 版本历史 localStorage 缓存键 */
export const HISTORY_CACHE_KEY = "wa-pi.version-history";

/** 分类标签配色：前景/背景成对取既有 token（新增 success、改进/优化 brand、修复 warning） */
const SECTION_COLORS: Record<string, { fg: string; bg: string }> = {
	新增: { fg: "var(--success)", bg: "var(--success-soft)" },
	改进: { fg: "var(--brand)", bg: "var(--accent-soft)" },
	优化: { fg: "var(--brand)", bg: "var(--accent-soft)" },
	修复: { fg: "var(--warning)", bg: "var(--warning-soft)" },
};

/** 取分类配色；未知分类（如「内核」）用次要文字色 + 悬浮底色 */
export function sectionColor(category: string): { fg: string; bg: string } {
	return (
		SECTION_COLORS[category] ?? {
			fg: "var(--text-secondary)",
			bg: "var(--surface-hover)",
		}
	);
}

/** x.y.z 形式版本号（内置 JSON 与线上数据均为该格式） */
export function isValidVersion(v: string): boolean {
	return /^\d+\.\d+\.\d+$/.test((v ?? "").trim());
}

function parseVersion(v: string): [number, number, number] {
	const parts = (v ?? "").trim().split(".");
	const out: [number, number, number] = [0, 0, 0];
	for (let i = 0; i < 3; i++) {
		const n = Number.parseInt(parts[i] ?? "", 10);
		out[i] = Number.isFinite(n) ? n : 0;
	}
	return out;
}

/** 语义化比较：a > b 返回正数；a < b 返回负数；相等返回 0。非法版本号按 0.0.0 处理 */
export function compareVersions(a: string, b: string): number {
	const pa = parseVersion(a);
	const pb = parseVersion(b);
	for (let i = 0; i < 3; i++) {
		if (pa[i] !== pb[i]) return pa[i] - pb[i];
	}
	return 0;
}

/** 单个版本的条目总数 */
export function countItems(entry: VersionEntry): number {
	return Object.values(entry.sections ?? {}).reduce(
		(n, items) => n + (items ? items.length : 0),
		0,
	);
}

/**
 * 多来源合并：按 version 去重（后出现的来源覆盖先出现的），按版本号倒序，截断至 limit。
 */
export function mergeVersionHistory(
	sources: VersionEntry[][],
	limit = MAX_VERSION_ENTRIES,
): VersionEntry[] {
	const map = new Map<string, VersionEntry>();
	for (const source of sources ?? []) {
		for (const entry of source ?? []) {
			if (!entry || typeof entry.version !== "string") continue;
			map.set(entry.version, entry);
		}
	}
	return Array.from(map.values())
		.sort((a, b) => compareVersions(b.version, a.version))
		.slice(0, limit);
}

/**
 * 更新区间筛选：返回 fromVersion < v <= toVersion 的版本（倒序）。
 * 任一版本号非法或区间反向时返回空数组（浏览器版 appVersion 为「—」时不应误报区间）。
 */
export function selectUpdatesBetween(
	entries: VersionEntry[],
	fromVersion: string,
	toVersion: string,
): VersionEntry[] {
	if (!isValidVersion(fromVersion) || !isValidVersion(toVersion)) return [];
	if (compareVersions(toVersion, fromVersion) <= 0) return [];
	return (entries ?? [])
		.filter(
			(e) =>
				compareVersions(e.version, fromVersion) > 0 &&
				compareVersions(e.version, toVersion) <= 0,
		)
		.sort((a, b) => compareVersions(b.version, a.version));
}

function storageOf(storage?: Storage): Storage | null {
	if (storage) return storage;
	return typeof localStorage === "undefined" ? null : localStorage;
}

/** 解析缓存内容：结构非法或缺字段一律丢弃该项 */
function parseCached(raw: string): VersionEntry[] {
	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(data)) return [];
	const out: VersionEntry[] = [];
	for (const item of data) {
		const e = item as VersionEntry;
		if (!e || typeof e !== "object") return [];
		if (typeof e.version !== "string" || typeof e.date !== "string") return [];
		if (!e.sections || typeof e.sections !== "object") return [];
		out.push(e);
	}
	return out;
}

/** 读 localStorage 缓存；任何异常都返回空数组（缓存只是加速，不该影响主流程） */
export function readHistoryCache(storage?: Storage): VersionEntry[] {
	const s = storageOf(storage);
	if (!s) return [];
	try {
		const raw = s.getItem(HISTORY_CACHE_KEY);
		return raw ? parseCached(raw) : [];
	} catch {
		return [];
	}
}

/** 写 localStorage 缓存（存线上原始数据，不含内置数据） */
export function writeHistoryCache(entries: VersionEntry[], storage?: Storage): void {
	const s = storageOf(storage);
	if (!s) return;
	try {
		s.setItem(HISTORY_CACHE_KEY, JSON.stringify(entries));
	} catch {
		/* 配额满/隐私模式：忽略 */
	}
}
