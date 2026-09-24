/**
 * 版本历史 store：合并三个来源（打包内置 / localStorage 缓存 / 内核代拉的线上数据），
 * 供「关于」页渲染最近 100 个版本，并据此算出「安装版 → 最新版」区间的更新内容。
 */
import { create } from "zustand";
import { api } from "../api-client";
import bundled from "../data/version-history.json";
import {
	mergeVersionHistory,
	readHistoryCache,
	writeHistoryCache,
	type VersionEntry,
} from "../util/version-history";

interface VersionHistoryState {
	/** 合并后按版本倒序、截断 100 条的列表 */
	entries: VersionEntry[];
	/** 当前 entries 的主要来源（bundled = 只有打包内置数据） */
	source: "bundled" | "cache" | "remote";
	loaded: boolean;
	load: () => Promise<void>;
}

const BUNDLED = bundled as VersionEntry[];

export const useVersionHistoryStore = create<VersionHistoryState>((set) => ({
	entries: mergeVersionHistory([BUNDLED]),
	source: "bundled",
	loaded: false,
	load: async () => {
		// 1) 先用上次落盘的线上数据暖场（离线/内核未就绪时也能看到较新的历史）
		const cached = readHistoryCache();
		if (cached.length) {
			set({
				entries: mergeVersionHistory([BUNDLED, cached]),
				source: "cache",
			});
		}
		// 2) 再拉线上（内核代拉，见 kernel/src/version-history.ts）；失败静默保留现有数据
		try {
			const data = (await api.get("/api/version-history")) as {
				history?: VersionEntry[];
			} | null;
			const remote = Array.isArray(data?.history) ? data.history : [];
			if (!remote.length) {
				set({ loaded: true });
				return;
			}
			writeHistoryCache(remote);
			set({
				entries: mergeVersionHistory([BUNDLED, cached, remote]),
				source: "remote",
				loaded: true,
			});
		} catch {
			set({ loaded: true });
		}
	},
}));
