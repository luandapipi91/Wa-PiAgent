import { beforeEach, expect, mock, test } from "bun:test";
import versionHistory from "../data/version-history.json";
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
	useVersionHistoryStore.setState({
		entries: versionHistory as never,
		source: "bundled",
		loaded: false,
	});
});

test("load 成功后合并线上数据并写缓存", async () => {
	await useVersionHistoryStore.getState().load();
	const state = useVersionHistoryStore.getState();
	expect(state.source).toBe("remote");
	expect(state.loaded).toBe(true);
	expect(state.entries[0].version).toBe("9.9.9");
	expect(localStorage.getItem(HISTORY_CACHE_KEY)).toContain("9.9.9");
});

test("load(true) 带 refresh=1 强制拉取（绕过内核缓存）", async () => {
	const paths: string[] = [];
	getImpl = async (path: string) => {
		paths.push(path);
		return { history: remote };
	};
	await useVersionHistoryStore.getState().load(true);
	expect(paths[0]).toContain("refresh=1");
});

test("load() 不带 refresh（走内核缓存）", async () => {
	const paths: string[] = [];
	getImpl = async (path: string) => {
		paths.push(path);
		return { history: remote };
	};
	await useVersionHistoryStore.getState().load();
	expect(paths[0]).toBe("/api/version-history");
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

test("store 层不截断条目（窗外旧版本须可命中更新区间），展示窗口由 VersionTimeline.slice 负责", async () => {
	// 回归：store 曾截断 100 条，真实 bundled 历史 ~124 条使更旧的版本（如升级弹窗
	// 需要的 0.2.0）被裁掉 → selectUpdatesBetween 恒空 → 关于页更新区间不渲染。
	const many = Array.from({ length: 150 }, (_, i) => ({
		version: `7.0.${150 - i}`,
		date: "2026-09-01",
		sections: { 修复: ["x"] },
	}));
	getImpl = async () => ({ history: many });
	await useVersionHistoryStore.getState().load();
	const entries = useVersionHistoryStore.getState().entries;
	// bundled + remote 合并去重：remote 150 条全部保留（不截断）
	expect(entries.length).toBeGreaterThanOrEqual(150);
	for (let i = 150; i >= 1; i--) {
		expect(entries.some((e) => e.version === `7.0.${i}`)).toBe(true);
	}
});
