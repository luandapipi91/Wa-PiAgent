// tui-host-registry.ts —— pi 进程内 tui-host 扩展上报的面板帧在 kernel 侧的会话态。
//
// 职责：缓存每个会话的面板与最新帧（供切会话/刷新时补发）、维护输入队列
// （扩展的输入订阅流未就绪时先排队），并把面板事件转成 SSE 广播。
// 不负责 pi 侧渲染，也不做节流（采样是唯一的节流点，规格 §4.5）。
//
// 事件通道按 kind 分流（规格 §6.4）：
// - kind=custom → extension_tui_open/frame/close（前端右上角三态浮窗）；
// - kind=widget → 复用既有 extension_widget 通道（Composer 上/下 widget 区），
//   open/close 只维护注册表状态不发事件，避免 widget 帧覆盖同会话的 custom 面板。
import type { TuiFrame } from "./tui-host/frame.ts";

export interface TuiPanelMeta {
	panelId: string;
	kind: "custom" | "widget";
	title: string;
	cols: number;
	rows: number;
	/** 同会话排队中的面板数（含当前这个） */
	pending: number;
	/** kind=widget 时的 widget key（前端 widget dock 的键） */
	widgetKey?: string;
	placement?: "aboveEditor" | "belowEditor";
}

export interface TuiInputEvent {
	sessionId: string;
	panelId: string;
	type: "key" | "paste" | "mouse" | "resize" | "cancel";
	data?: string;
	cols?: number;
	rows?: number;
}

/** 扩展帧流推来的一帧（规格 §5.1 的 NDJSON 行；缺省字段由 applyFrame 兜底） */
export interface TuiHostFrame {
	/** open | frame | close | ping（ping 是心跳，静默忽略） */
	type: string;
	panelId?: string;
	kind?: "custom" | "widget";
	title?: string;
	cols?: number;
	rows?: number;
	pending?: number;
	widgetKey?: string;
	placement?: "aboveEditor" | "belowEditor";
	lines?: string[];
	cursor?: TuiFrame["cursor"];
	reason?: string;
}

interface PanelEntry extends TuiPanelMeta {
	lastFrame: TuiFrame | null;
}

interface SessionEntry {
	panels: Map<string, PanelEntry>;
	queue: string[];
	subscriber: ((line: string) => void) | null;
}

/** 帧缺省尺寸：与扩展侧的开面板尺寸一致（规格 §5.1 全局约束 85×24） */
const DEFAULT_COLS = 85;
const DEFAULT_ROWS = 24;
const DEFAULT_TITLE = "扩展面板";

/** 输入队列上限：订阅流断开期间不能无限增长（断连时丢弃旧输入比卡内存合理） */
const MAX_QUEUE = 500;

export interface TuiHostRegistryOptions {
	/** 向该会话的前端广播 SSE 事件（由 ws-server 注入） */
	broadcast: (sessionId: string, event: Record<string, unknown>) => void;
}

export interface TuiHostRegistry {
	openPanel(sessionId: string, meta: TuiPanelMeta): void;
	pushFrame(sessionId: string, panelId: string, frame: TuiFrame): void;
	closePanel(sessionId: string, panelId: string, reason: string): void;
	/** 帧流入口：把 open/frame/close 三类帧分派到上面三个方法（其余帧忽略） */
	applyFrame(sessionId: string, frame: TuiHostFrame): void;
	enqueueInput(event: TuiInputEvent): void;
	attachSubscriber(sessionId: string, write: (line: string) => void): () => void;
	snapshot(
		sessionId: string,
	): { panels: Array<TuiPanelMeta & { lastFrame: TuiFrame | null }> } | null;
	/** 有状态的会话 id（测试与将来的会话清理用） */
	sessionIds(): string[];
	clearSession(sessionId: string): void;
}

/**
 * widget 面板的 widget key：协议规定 panelId = `w:<key>`（规格 §5.1），帧里的 widgetKey 更权威。
 * 两处使用（open 建档、frame 转发）保持同一解析规则。
 */
const widgetKeyOf = (panelId: string, widgetKey?: string): string =>
	widgetKey ?? panelId.replace(/^w:/, "");

/**
 * 扩展面板的会话态注册表。
 *
 * 实例由 createTuiHostRegistry 构造；广播出口是可注入的（生产由 ws-server 注入 SSE）。
 */
export function createTuiHostRegistry(
	opts: TuiHostRegistryOptions,
): TuiHostRegistry {
	const bySession = new Map<string, SessionEntry>();

	const entry = (sessionId: string): SessionEntry => {
		let cur = bySession.get(sessionId);
		if (!cur) {
			cur = { panels: new Map(), queue: [], subscriber: null };
			bySession.set(sessionId, cur);
		}
		return cur;
	};

	const openPanel = (sessionId: string, meta: TuiPanelMeta) => {
		const cur = entry(sessionId);
		cur.panels.set(meta.panelId, { ...meta, lastFrame: null });
		// widget 走既有 extension_widget 通道：open 只为记住 placement/widgetKey 供后续帧复用
		if (meta.kind === "widget") return;
		opts.broadcast(sessionId, {
			type: "extension_tui_open",
			panelId: meta.panelId,
			kind: meta.kind,
			title: meta.title,
			cols: meta.cols,
			rows: meta.rows,
			pending: meta.pending,
		});
	};

	const pushFrame = (sessionId: string, panelId: string, frame: TuiFrame) => {
		const cur = bySession.get(sessionId);
		const panel = cur?.panels.get(panelId);
		if (!cur || !panel) return;
		panel.lastFrame = frame;
		if (panel.kind === "widget") {
			opts.broadcast(sessionId, {
				type: "extension_widget",
				widgetKey: widgetKeyOf(panel.panelId, panel.widgetKey),
				widgetLines: frame.lines,
				widgetPlacement: panel.placement ?? "aboveEditor",
			});
			return;
		}
		opts.broadcast(sessionId, {
			type: "extension_tui_frame",
			panelId,
			lines: frame.lines,
			cursor: frame.cursor,
		});
	};

	const closePanel = (sessionId: string, panelId: string, reason: string) => {
		const cur = bySession.get(sessionId);
		if (!cur) return;
		const panel = cur.panels.get(panelId);
		cur.panels.delete(panelId);
		// widget 的消失由扩展侧的 setWidget（pi 通道，空内容即清除）负责通知前端，这里只清状态
		if (panel?.kind === "widget") return;
		opts.broadcast(sessionId, { type: "extension_tui_close", panelId, reason });
	};

	const applyFrame = (sessionId: string, frame: TuiHostFrame) => {
		const panelId = frame.panelId;
		switch (frame.type) {
			case "open": {
				if (typeof panelId !== "string") return;
				const kind = frame.kind === "widget" ? "widget" : "custom";
				openPanel(sessionId, {
					panelId,
					kind,
					title: frame.title ?? DEFAULT_TITLE,
					cols: frame.cols ?? DEFAULT_COLS,
					rows: frame.rows ?? DEFAULT_ROWS,
					pending: frame.pending ?? 1,
					...(kind === "widget"
						? { widgetKey: widgetKeyOf(panelId, frame.widgetKey) }
						: {}),
					...(frame.placement ? { placement: frame.placement } : {}),
				});
				return;
			}
			case "frame": {
				if (typeof panelId !== "string") return;
				pushFrame(sessionId, panelId, {
					lines: frame.lines ?? [],
					cursor: frame.cursor ?? null,
				});
				return;
			}
			case "close": {
				if (typeof panelId !== "string") return;
				closePanel(sessionId, panelId, frame.reason ?? "done");
				return;
			}
			default:
				// ping（心跳）等未定义帧静默忽略：协议不匹配时不拿日志刷屏
				return;
		}
	};

	const enqueueInput = (event: TuiInputEvent) => {
		const cur = entry(event.sessionId);
		const line = JSON.stringify({
			type: event.type,
			panelId: event.panelId,
			...(event.data === undefined ? {} : { data: event.data }),
			...(event.cols === undefined ? {} : { cols: event.cols }),
			...(event.rows === undefined ? {} : { rows: event.rows }),
		});
		if (cur.subscriber) {
			cur.subscriber(line);
			return;
		}
		cur.queue.push(line);
		if (cur.queue.length > MAX_QUEUE)
			cur.queue.splice(0, cur.queue.length - MAX_QUEUE);
	};

	const attachSubscriber = (
		sessionId: string,
		write: (line: string) => void,
	): (() => void) => {
		const cur = entry(sessionId);
		cur.subscriber = write;
		const pending = cur.queue.splice(0, cur.queue.length);
		for (const line of pending) write(line);
		return () => {
			const live = bySession.get(sessionId);
			if (live && live.subscriber === write) live.subscriber = null;
		};
	};

	const snapshot = (sessionId: string) => {
		const cur = bySession.get(sessionId);
		if (!cur) return null;
		return { panels: [...cur.panels.values()].map((p) => ({ ...p })) };
	};

	const sessionIds = () => [...bySession.keys()];

	const clearSession = (sessionId: string) => {
		const cur = bySession.get(sessionId);
		bySession.delete(sessionId);
		if (!cur) return;
		// 会话销毁（进程拆除/重建）：在开的 custom 面板必须通知前端收起（规格 §6.1），
		// 否则旧帧会变成点不掉的幽灵面板（扩展进程已死，后续输入无人接）。
		// reason 用 `dispose`（规格 §4.8 把「会话销毁」列为独立终止路径，与用户取消区分），
		// 与扩展侧 `disposeAll` 的口径一致；前端不读 reason，只按事件卸载面板。
		// widget 不在此列：它们的清除由 ctx.ui.setWidget 的 pi 通道与 extension_ui_reset 覆盖。
		for (const panel of cur.panels.values()) {
			if (panel.kind === "widget") continue;
			opts.broadcast(sessionId, {
				type: "extension_tui_close",
				panelId: panel.panelId,
				reason: "dispose",
			});
		}
	};

	return {
		openPanel,
		pushFrame,
		closePanel,
		applyFrame,
		enqueueInput,
		attachSubscriber,
		snapshot,
		sessionIds,
		clearSession,
	};
}

type TuiBroadcast = (sessionId: string, event: Record<string, unknown>) => void;

let broadcastSink: TuiBroadcast = () => {};

/** ws-server 启动时注入 SSE 出口（模块级单例的广播依赖，与 index.ts 的 crashBroadcast 同模式） */
export function setTuiHostBroadcast(fn: TuiBroadcast): void {
	broadcastSink = fn;
}

/**
 * 进程级单例（与 extUiRegistry / askRegistry 同模式）：帧流与输入订阅流端点、以及
 * agent-manager 的会话销毁路径都要用它，因此不能只存在 ws-server 实例里。
 */
export const tuiHostRegistry = createTuiHostRegistry({
	broadcast: (sessionId, event) => broadcastSink(sessionId, event),
});
