import { beforeEach, expect, mock, test } from "bun:test";
import { HISTORY_CACHE_KEY, type VersionEntry } from "../util/version-history";

const remote: VersionEntry[] = [
	{ version: "9.9.9", date: "2026-10-01", sections: { 新增: ["线上新版本"] } },
];

let getImpl: (path: string) => Promise<unknown> = async () => ({ history: remote });

mock.module("../api-client", () => ({
	api: {
		get: (path: string) => getImpl(path),
		post: async () => ({}),
		put: async () => ({}),
		del: async () => ({}),
	},
}));

const { useVersionHistoryStore } = await import("./version-history");

beforeEach(() => {
	localStorage.clear();
	getImpl = async () => ({ history: remote });
	useVersionHistoryStore.setState({ loaded: false });
});

test("load 成功后合并线上数据并写缓存", async () => {
	await useVersionHistoryStore.getState().load();
	const state = useVersionHistoryStore.getState();
	expect(state.source).toBe("remote");
	expect(state.loaded).toBe(true);
	expect(state.entries[0].version).toBe("9.9.9");
	expect(localStorage.getItem(HISTORY_CACHE_KEY)).toContain("9.9.9");
});

test("load 失败时保留内置数据，不抛错", async () => {
	getImpl = async () => {
		throw new Error("kernel down");
	};
	await useVersionHistoryStore.getState().load();
	const state = useVersionHistoryStore.getState();
	expect(state.loaded).toBe(true);
	expect(state.source).toBe("bundled");
	expect(state.entries.length).toBeGreaterThan(0);
});

test("load 返回空历史时用缓存兜底", async () => {
	localStorage.setItem(
		HISTORY_CACHE_KEY,
		JSON.stringify([
			{ version: "8.8.8", date: "2026-09-30", sections: { 修复: ["缓存版本"] } },
		]),
	);
	getImpl = async () => ({ history: [] });
	await useVersionHistoryStore.getState().load();
	const state = useVersionHistoryStore.getState();
	expect(state.source).toBe("cache");
	expect(state.entries[0].version).toBe("8.8.8");
});

test("条目上限 100", async () => {
	const many = Array.from({ length: 150 }, (_, i) => ({
		version: `7.0.${150 - i}`,
		date: "2026-09-01",
		sections: { 修复: ["x"] },
	}));
	getImpl = async () => ({ history: many });
	await useVersionHistoryStore.getState().load();
	expect(useVersionHistoryStore.getState().entries.length).toBe(100);
});
