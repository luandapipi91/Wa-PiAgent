import { test, expect } from "bun:test";
import {
	HISTORY_CACHE_KEY,
	MAX_VERSION_ENTRIES,
	compareVersions,
	countItems,
	mergeVersionHistory,
	readHistoryCache,
	sectionColor,
	selectUpdatesBetween,
	writeHistoryCache,
	type VersionEntry,
} from "./version-history";

const entry = (
	version: string,
	sections: Record<string, string[] | undefined> = { 修复: ["x"] },
): VersionEntry => ({ version, date: "2026-01-01", sections });

test("compareVersions：按数字段比较，越界段按 0，非法按 0", () => {
	expect(compareVersions("0.6.10", "0.6.9")).toBeGreaterThan(0);
	expect(compareVersions("0.6.9", "0.6.10")).toBeLessThan(0);
	expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
	expect(compareVersions("0.2", "0.2.0")).toBe(0);
	expect(compareVersions("—", "0.1.0")).toBeLessThan(0);
});

test("MAX_VERSION_ENTRIES 为 100", () => {
	expect(MAX_VERSION_ENTRIES).toBe(100);
});

test("countItems：累计各分类条目数", () => {
	expect(countItems(entry("0.1.0", { 新增: ["a", "b"], 修复: ["c"], 空: undefined }))).toBe(3);
});

test("mergeVersionHistory：并集去重、后源覆盖、倒序、截断", () => {
	const bundled = [entry("0.1.0"), entry("0.2.0")];
	const remote = [entry("0.3.0"), entry("0.2.0", { 新增: ["覆盖"] })];
	const merged = mergeVersionHistory([bundled, remote]);
	expect(merged.map((e) => e.version)).toEqual(["0.3.0", "0.2.0", "0.1.0"]);
	expect(merged[1].sections).toEqual({ 新增: ["覆盖"] });
});

test("mergeVersionHistory：limit 截断最新 100 条", () => {
	const many = Array.from({ length: 120 }, (_, i) =>
		entry(`1.0.${120 - i}`),
	);
	const merged = mergeVersionHistory([many]);
	expect(merged.length).toBe(100);
	expect(merged[0].version).toBe("1.0.120");
	expect(merged[99].version).toBe("1.0.21");
});

test("selectUpdatesBetween：取安装版与最新版之间的版本，倒序", () => {
	const entries = [entry("0.6.10"), entry("0.6.9"), entry("0.6.5"), entry("0.6.4")];
	const picked = selectUpdatesBetween(entries, "0.6.5", "0.6.10");
	expect(picked.map((e) => e.version)).toEqual(["0.6.10", "0.6.9"]);
});

test("selectUpdatesBetween：非法版本或反向区间返回空数组", () => {
	const entries = [entry("0.6.10")];
	expect(selectUpdatesBetween(entries, "—", "0.6.10")).toEqual([]);
	expect(selectUpdatesBetween(entries, "0.6.10", "0.6.5")).toEqual([]);
});

test("sectionColor：已知分类用 token 对，未知分类回退", () => {
	expect(sectionColor("修复")).toEqual({ fg: "var(--warning)", bg: "var(--warning-soft)" });
	expect(sectionColor("内核")).toEqual({
		fg: "var(--text-secondary)",
		bg: "var(--surface-hover)",
	});
});

test("writeHistoryCache / readHistoryCache：往返一致并过滤脏数据", () => {
	const storage = new Map<string, string>();
	const fake = {
		getItem: (k: string) => storage.get(k) ?? null,
		setItem: (k: string, v: string) => void storage.set(k, v),
	} as unknown as Storage;
	writeHistoryCache([entry("0.6.10")], fake);
	expect(storage.has(HISTORY_CACHE_KEY)).toBe(true);
	expect(readHistoryCache(fake).map((e) => e.version)).toEqual(["0.6.10"]);
	// 脏数据（非数组 / 缺字段）→ 空数组，不抛
	storage.set(HISTORY_CACHE_KEY, '{"a":1}');
	expect(readHistoryCache(fake)).toEqual([]);
	storage.set(HISTORY_CACHE_KEY, '[{"version":"0.1.0"},{"version":123}]');
	expect(readHistoryCache(fake)).toEqual([]);
	storage.set(HISTORY_CACHE_KEY, "not-json");
	expect(readHistoryCache(fake)).toEqual([]);
});
