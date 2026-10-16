// 扩展 TUI 面板（ctx.ui.custom 兼容）的前端状态：右上角三态浮窗的数据源。
//
// 边界（规格 §6.4）——**只处理 custom 面板**，三个事件：
//   extension_tui_open / extension_tui_frame / extension_tui_close（由 store/session.ts 分派）。
// widget 面板的帧 **不**进本 store：它们由 kernel 转成既有的 extension_widget 事件、
// 走 store/session.ts 的 extWidgetBySession → SessionView 的 ExtWidgetDock 通道，
// 与本浮窗互不覆盖（同一会话二者可并存）。
//
// 三态模型（规格 §7.1）：expanded（展开，键盘锁面板）/ badge（挂件卡片，预览实时帧）/
// pill（胶囊）。收起逐级下探，展开一步到位；上次收起级别记在 lastCollapsedMode 里。
import { create } from "zustand";
import type { ExtensionTuiSnapshotResult } from "@wa-pi/shared";

export type TuiPanelMode = "expanded" | "badge" | "pill";

export interface TuiPanelView {
	panelId: string;
	kind: "custom" | "widget";
	title: string;
	cols: number;
	rows: number;
	/** 同会话排队中的面板数（含当前） */
	pending: number;
	lines: string[];
	cursor: { row: number; col: number } | null;
	mode: TuiPanelMode;
	/** 记住用户上次的收起级别，下次「—」直接回到该级别（默认挂件） */
	lastCollapsedMode: "badge" | "pill";
}

type TuiPanelMeta = Omit<
	TuiPanelView,
	"lines" | "cursor" | "mode" | "lastCollapsedMode"
>;

interface TuiPanelState {
	/** 按会话索引；同会话同时只有一个 custom 面板（规格 §4.7） */
	bySession: Record<string, TuiPanelView | undefined>;
	open: (sessionId: string, meta: TuiPanelMeta) => void;
	setFrame: (
		sessionId: string,
		panelId: string,
		lines: string[],
		cursor: TuiPanelView["cursor"],
	) => void;
	close: (sessionId: string) => void;
	/** 补发（规格 §5.4）：会话切换/前端重连时用 kernel 快照铺回面板与最后一帧 */
	restoreFrom: (sessionId: string, snapshot: ExtensionTuiSnapshotResult) => void;
	expand: (sessionId: string) => void;
	collapse: (sessionId: string) => void;
	collapseDeeper: (sessionId: string) => void;
	clear: () => void;
}

/**
 * 未打开的会话收到帧/操作一律静默忽略：帧可能来自已被清理的旧面板，
 * 或来自本会话已切走的旧面板（见 setFrame 的 panelId 校验）。
 */
export const useTuiPanelStore = create<TuiPanelState>((set) => ({
	bySession: {},

	open: (sessionId, meta) =>
		set((s) => ({
			bySession: {
				...s.bySession,
				[sessionId]: {
					...meta,
					lines: [],
					cursor: null,
					mode: "expanded",
					lastCollapsedMode: s.bySession[sessionId]?.lastCollapsedMode ?? "badge",
				},
			},
		})),

	// panelId 不匹配即丢弃（规格 §8「面板重复开关竞态：前端丢弃非当前 id 的帧」）：
	// 面板切换后旧面板的迟到帧不能覆盖新面板的画面。
	setFrame: (sessionId, panelId, lines, cursor) =>
		set((s) => {
			const cur = s.bySession[sessionId];
			if (!cur || cur.panelId !== panelId) return s;
			return {
				bySession: { ...s.bySession, [sessionId]: { ...cur, lines, cursor } },
			};
		}),

	close: (sessionId) =>
		set((s) => {
			if (!s.bySession[sessionId]) return s;
			const next = { ...s.bySession };
			delete next[sessionId];
			return { bySession: next };
		}),

	restoreFrom: (sessionId, snapshot) =>
		set((s) => {
			// 快照含 widget 面板（registry 原样透传）：本 store 只认 custom，其余忽略
			const panel = [...snapshot.panels]
				.reverse()
				.find((p) => p.kind === "custom");
			const prev = s.bySession[sessionId];
			const bySession = { ...s.bySession };
			if (!panel) {
				// 快照里没有 custom 面板 = 前端断开期间面板已关：清掉陈旧状态
				delete bySession[sessionId];
				return { bySession };
			}
			bySession[sessionId] = {
				panelId: panel.panelId,
				kind: panel.kind,
				title: panel.title,
				cols: panel.cols,
				rows: panel.rows,
				pending: panel.pending,
				lines: panel.lastFrame?.lines ?? [],
				cursor: panel.lastFrame?.cursor ?? null,
				// 三态是用户态、快照不含：同一面板沿用用户当前态，换成新面板才回到默认展开
				mode: prev?.panelId === panel.panelId ? prev.mode : "expanded",
				lastCollapsedMode:
					prev?.panelId === panel.panelId ? prev.lastCollapsedMode : "badge",
			};
			return { bySession };
		}),

	expand: (sessionId) =>
		set((s) => {
			const cur = s.bySession[sessionId];
			if (!cur || cur.mode === "expanded") return s;
			return {
				bySession: { ...s.bySession, [sessionId]: { ...cur, mode: "expanded" } },
			};
		}),

	collapse: (sessionId) =>
		set((s) => {
			const cur = s.bySession[sessionId];
			if (!cur || cur.mode === cur.lastCollapsedMode) return s;
			return {
				bySession: {
					...s.bySession,
					[sessionId]: { ...cur, mode: cur.lastCollapsedMode },
				},
			};
		}),

	collapseDeeper: (sessionId) =>
		set((s) => {
			const cur = s.bySession[sessionId];
			if (!cur || cur.mode === "pill") return s;
			return {
				bySession: {
					...s.bySession,
					[sessionId]: { ...cur, mode: "pill", lastCollapsedMode: "pill" },
				},
			};
		}),

	clear: () => set({ bySession: {} }),
}));
