import { create } from "zustand";

/** 扩展错误诊断条目（系统设置 > 诊断 展示） */
export interface DiagnosticsEntry {
	id: number;
	timestamp: number;
	/** 展示用扩展名（extensionPath 的 basename 去扩展名） */
	extension: string;
	/** 出错的 pi 生命周期钩子（tool_call / session_start 等） */
	event: string;
	error: string;
}

interface DiagnosticsState {
	entries: DiagnosticsEntry[];
	add: (e: { extension: string; event: string; error: string }) => void;
	clear: () => void;
}

/** 只留最近 50 条：内存态排障用，不持久化 */
const MAX_ENTRIES = 50;

let nextId = 1;

export const useDiagnosticsStore = create<DiagnosticsState>((set) => ({
	entries: [],
	add: (e) =>
		set((s) => ({
			entries: [
				{ ...e, id: nextId++, timestamp: Date.now() },
				...s.entries,
			].slice(0, MAX_ENTRIES),
		})),
	clear: () => set({ entries: [] }),
}));

/** extensionPath → 展示名：取 basename 并去扩展名（/a/b/pi-lens.ts → pi-lens） */
export function extensionNameFromPath(p: string): string {
	const base = p.split(/[\\/]/).pop() ?? p;
	return base.replace(/\.[^.]+$/, "");
}
