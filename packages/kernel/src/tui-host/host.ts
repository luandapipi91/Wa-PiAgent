// tui-host/host.ts —— pi 侧 tui-host 扩展的宿主接线层
//
// 三块职责：
// 1. 与 kernel 的帧出口（createFrameSink）：面板帧经此流向 kernel 的
//    /bridge/tui-host/frames 长连接（规格 §5.1）；
// 2. RPC 模式下接管 ctx.ui 的 custom / setWidget / onTerminalInput（规格 §4.3/4.4/4.6）；
// 3. 面板桥（createPanelBridge）：把接管的调用落到真实面板/widget 宿主上，
//    并把 kernel 推来的输入事件按 panelId 路由回宿主（规格 §4.7）。
//
// 本目录会被原样复制到 GENERATED_DIR 供 pi 进程加载，因此只依赖 pi-tui /
// pi-coding-agent 的类型（`import type` 擦除后无运行时代价）。
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { createPanelHost, type PanelHost } from "./panel.ts";
import { createWidgetHost, type WidgetHost } from "./widget.ts";

/** NDJSON 行切分：返回完整行与剩余半行 */
export function splitNdjson(buffer: string, chunk: string): { lines: string[]; rest: string } {
	const merged = buffer + chunk;
	const parts = merged.split("\n");
	const rest = parts.pop() ?? "";
	return { lines: parts.filter((l) => l.trim().length > 0), rest };
}

export interface FrameSink {
	push(frame: Record<string, unknown>): void;
	attach(write: (line: string) => void): void;
	detach(): void;
}

/**
 * 帧出口：扩展与 kernel 的帧流未就绪时先把帧排队，就绪后按序 flush。
 * 队列有上限，溢出丢最旧的帧——面板画面永远以最新一帧为准，
 * 丢旧帧比卡内存或迟延渲染合理。
 *
 * detach 在连接断开后调用：回到排队态，否则后续帧会写向已关掉的连接而被静默丢掉。
 */
export function createFrameSink(opts: { maxQueue?: number } = {}): FrameSink {
	const maxQueue = opts.maxQueue ?? 200;
	const queue: string[] = [];
	let writer: ((line: string) => void) | null = null;
	return {
		push: (frame) => {
			const line = JSON.stringify(frame);
			if (writer) {
				writer(line);
				return;
			}
			queue.push(line);
			if (queue.length > maxQueue) queue.splice(0, queue.length - maxQueue);
		},
		attach: (write) => {
			writer = write;
			const pending = queue.splice(0, queue.length);
			for (const line of pending) write(line);
		},
		detach: () => {
			writer = null;
		},
	};
}

export interface TuiHostPatchBridge {
	openCustom: (factory: unknown, options: unknown, ctx: unknown) => Promise<unknown>;
	openWidget: (key: string, factory: unknown, options: unknown, ctx: unknown) => void;
	setInputListeners: (listeners: Set<(data: string) => void>) => void;
}

export interface PanelBridgeOptions {
	sink: FrameSink;
	/** pi 的 Theme（取自 ctx.ui.theme）；未提供时组件收到 undefined */
	theme?: Theme;
	/** pi 的 KeybindingsManager（来自 pi-tui 的 getKeybindings()） */
	keybindings?: KeybindingsManager;
}

export interface PanelBridge extends TuiHostPatchBridge {
	/** kernel 推来的输入事件，按 panelId 路由到对应宿主（规格 §4.7） */
	handleInput(event: TuiHostInputEvent): void;
	/** 会话 teardown：结算所有排队/在开的面板，关掉 widget 采样（规格 §4.8） */
	disposeAll(): void;
}

/** pi 的 custom 没有 title 字段，面板标题只能由宿主给一个固定值（规格 §5.1 的 title 字段） */
const PANEL_TITLE = "扩展面板";
const PANEL_COLS = 85;
const PANEL_ROWS = 24;
const WIDGET_COLS = 80;
const WIDGET_ROWS = 10;
/** widget 的采样节奏，与 panel.ts 的 80ms 一致（采样是唯一的节流点，规格 §4.5） */
const WIDGET_SAMPLE_MS = 80;

/**
 * 把 patchUiForTuiHost 的三个接管点落到真实宿主上：
 * custom → createPanelHost（串行队列），setWidget 组件工厂 → createWidgetHost，
 * 输入监听器 → 反转交给 kernel 推来的事件（规格 §4.3/4.4/4.6/4.7）。
 */
export function createPanelBridge(opts: PanelBridgeOptions): PanelBridge {
	const { sink } = opts;
	let seq = 0;
	let disposed = false;
	let active: { panelId: string; host: PanelHost<unknown> } | null = null;
	/** 同会话同时只开一个面板：并发的 custom 在这里排队（规格 §4.7） */
	const waiting: Array<() => void> = [];
	const widgets = new Map<string, { host: WidgetHost; timer: ReturnType<typeof setInterval> }>();
	// 持有 Set 引用而不是拷贝：patchUiForTuiHost 先建集合并交给我们，插件随后才 add
	// （onTerminalInput 随时可能被调用），拷贝会让后注册的监听器永远收不到输入。
	let inputListeners = new Set<(data: string) => void>();

	const next = () => {
		if (disposed) return;
		const start = waiting.shift();
		if (start) start();
	};

	const startPanel = (factory: unknown, resolve: (value: unknown) => void) => {
		if (disposed) {
			resolve(undefined);
			return;
		}
		const panelId = `p${++seq}`;
		const host = createPanelHost<unknown>({
			title: PANEL_TITLE,
			cols: PANEL_COLS,
			rows: PANEL_ROWS,
			factory: factory as never,
			theme: opts.theme as Theme,
			keybindings: opts.keybindings as KeybindingsManager,
			onFrame: (frame) => sink.push({ type: "frame", panelId, lines: frame.lines, cursor: frame.cursor }),
		});
		active = { panelId, host };
		sink.push({
			type: "open",
			panelId,
			kind: "custom",
			title: PANEL_TITLE,
			cols: PANEL_COLS,
			rows: PANEL_ROWS,
			pending: waiting.length + 1,
		});

		const finish = (value: unknown, reason: string) => {
			sink.push({ type: "close", panelId, reason });
			if (active?.panelId === panelId) active = null;
			resolve(value);
			next();
		};

		// 工厂抛错或返回空值：panel.ts 在 factory 同步返回 undefined 时会在 isThenable
		// 处抛 TypeError（既不 settle 也不留挂起）。这里必须兜住并保证结算，否则插件的
		// `await ui.custom(...)` 会永久挂起——历史上 custom() 挂死导致命令一直「思考中」
		// 就是这类 bug。开面板失败时 open 帧已发出，补一帧 close 让前端收拾干净。
		try {
			host.start();
		} catch {
			try {
				host.dispose();
			} catch {
				/* 收尾异常不影响结算 */
			}
			finish(undefined, "cancel");
			return;
		}

		void host.result.then((r) => {
			const done = r.status === "done";
			finish(done ? r.value : undefined, done ? "done" : "cancel");
		});
	};

	const forwardToListeners = (data: string) => {
		for (const listener of inputListeners) {
			try {
				listener(data);
			} catch {
				/* 单个插件监听器异常不影响其它监听器与面板 */
			}
		}
	};

	return {
		openCustom: (factory, _options, _ctx) =>
			new Promise<unknown>((resolve) => {
				const start = () => startPanel(factory, resolve);
				if (active) waiting.push(start);
				else start();
			}),

		openWidget: (key, factory, options, _ctx) => {
			const existing = widgets.get(key);
			if (existing) {
				clearInterval(existing.timer);
				existing.host.dispose();
				widgets.delete(key);
			}
			const host = createWidgetHost({ cols: WIDGET_COLS, factory: factory as never, theme: opts.theme as Theme });
			const panelId = `w:${key}`;
			// placement 沿 pi 的 widget 语义（规格 §4.4）：前端 dock 据此决定摆在输入框上方还是下方
			const placement = (options as { placement?: "aboveEditor" | "belowEditor" } | undefined)?.placement;
			sink.push({
				type: "open",
				panelId,
				kind: "widget",
				widgetKey: key,
				title: key,
				cols: WIDGET_COLS,
				rows: WIDGET_ROWS,
				pending: 1,
				...(placement ? { placement } : {}),
			});
			host.start();
			const timer = setInterval(() => {
				const frame = host.sample();
				if (frame) sink.push({ type: "frame", panelId, kind: "widget", widgetKey: key, lines: frame.lines });
			}, WIDGET_SAMPLE_MS);
			widgets.set(key, { host, timer });
		},

		setInputListeners: (listeners) => {
			inputListeners = listeners;
		},

		handleInput: (event) => {
			const panelId = event.panelId;
			if (!panelId) return;
			if (event.type === "cancel") {
				if (active?.panelId === panelId) active.host.cancel();
				return;
			}
			// widget 无焦点、不收键盘/鼠标（规格 §4.4），只接受尺寸变化
			if (panelId.startsWith("w:")) {
				if (event.type === "resize" && typeof event.cols === "number") widgets.get(panelId.slice(2))?.host.resize(event.cols);
				return;
			}
			if (active?.panelId !== panelId) return;
			if (event.type === "resize") {
				active.host.resize(event.cols ?? PANEL_COLS, event.rows ?? PANEL_ROWS);
				return;
			}
			if (event.data === undefined) return;
			if (event.type === "key" || event.type === "paste" || event.type === "mouse") {
				active.host.inject(event.data);
				// 插件注册的 onTerminalInput 监听器只收按键/粘贴（鼠标序列由 TuiAltScreen 自己解析）
				if (event.type !== "mouse") forwardToListeners(event.data);
			}
		},

		disposeAll: () => {
			disposed = true;
			for (const start of waiting.splice(0, waiting.length)) start();
			for (const widget of widgets.values()) {
				clearInterval(widget.timer);
				widget.host.dispose();
			}
			widgets.clear();
			active?.host.dispose();
			active = null;
		},
	};
}

/**
 * 接管 ui 上下文的三个成员（规格 §4.3/4.4/4.6）。
 *
 * 幂等：已打过标记的 ui 直接返回，避免多个 session_start 反复包裹。
 * 标记 `__waPiTuiHost` 同时供 wa-pi-bridge 的 notify+throw 兜底让位。
 */
export function patchUiForTuiHost(ui: Record<string, unknown>, bridge: TuiHostPatchBridge): void {
	if (ui.__waPiTuiHost === true) return;
	ui.__waPiTuiHost = true;

	const originalSetWidget = ui.setWidget as ((key: string, content: unknown, options?: unknown) => void) | undefined;
	const listeners = new Set<(data: string) => void>();
	bridge.setInputListeners(listeners);

	ui.custom = (factory: unknown, options: unknown, ctx: unknown) => bridge.openCustom(factory, options, ctx);

	ui.setWidget = (key: string, content: unknown, options?: unknown) => {
		if (typeof content === "function") {
			bridge.openWidget(key, content, options, undefined);
			return;
		}
		originalSetWidget?.(key, content, options);
	};

	ui.onTerminalInput = (cb: (data: string) => void) => {
		listeners.add(cb);
		return () => {
			listeners.delete(cb);
		};
	};
}

/** kernel 推来的输入事件（规格 §5.2） */
export interface TuiHostInputEvent {
	type: string;
	panelId?: string;
	data?: string;
	cols?: number;
	rows?: number;
}

export interface InputChannelOptions {
	/** kernel 的 bridge 基址（WA_PI_BRIDGE_URL） */
	bridgeUrl: string;
	token: string;
	sessionId: string;
	onEvent: (event: TuiHostInputEvent) => void;
	/** 断流后的重连间隔（规格 §8：帧流/订阅流断开要能恢复） */
	retryMs?: number;
	/** 便于单测注入 */
	fetchImpl?: typeof fetch;
}

export interface InputChannel {
	start(): void;
	stop(): void;
}

const DEFAULT_RETRY_MS = 1000;

/**
 * 订阅 kernel 的输入流（规格 §5.2）：POST /bridge/tui-host/subscribe 的 NDJSON
 * 响应里逐行给出按键/粘贴/鼠标/尺寸/取消事件，交给 onEvent 路由到对应宿主。
 *
 * 取舍：断流只重试、不抛——pi 的主循环不能被扩展的网络问题打断；kernel 在无订阅者
 * 时会把输入排队，重连后自动补发（规格 §6.1）。
 */
export function connectInputChannel(opts: InputChannelOptions): InputChannel {
	const fetchImpl = opts.fetchImpl ?? fetch;
	const retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
	const abort = new AbortController();
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | null = null;

	const run = async (): Promise<void> => {
		if (stopped) return;
		try {
			const res = await fetchImpl(`${opts.bridgeUrl}/bridge/tui-host/subscribe`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ token: opts.token, sessionId: opts.sessionId }),
				signal: abort.signal,
			});
			if (!res.ok || !res.body) throw new Error(`subscribe ${res.status}`);
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			let rest = "";
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				const chunk = splitNdjson(rest, decoder.decode(value, { stream: true }));
				rest = chunk.rest;
				for (const line of chunk.lines) {
					let event: TuiHostInputEvent;
					try {
						event = JSON.parse(line) as TuiHostInputEvent;
					} catch {
						continue; // 脏行：跳过，保持订阅流
					}
					try {
						opts.onEvent(event);
					} catch {
						// 单个事件的宿主/插件异常不打断读流
					}
				}
			}
		} catch {
			// 连接或读取失败：下面统一重连
		}
		if (stopped) return;
		timer = setTimeout(() => void run(), retryMs);
	};

	return {
		start: () => void run(),
		stop: () => {
			stopped = true;
			if (timer) clearTimeout(timer);
			timer = null;
			abort.abort();
		},
	};
}
