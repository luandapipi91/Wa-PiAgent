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
import type {
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import { createPanelHost, type PanelHost } from "./panel.ts";
import { createWidgetHost, type WidgetHost } from "./widget.ts";

/** NDJSON 行切分：返回完整行与剩余半行 */
export function splitNdjson(
	buffer: string,
	chunk: string,
): { lines: string[]; rest: string } {
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
 * 队列有上限，溢出时**优先丢画面帧**（`frame`）而留住 `open`/`close` 控制帧：
 * 丢 close 会让前端留下永不消失的幽灵面板，丢 open 会让后续帧指向未知面板；
 * 队列里全是控制帧时才退化为丢最旧（保最新发生的 open/close）。
 * 画面帧永远以最新一帧为准，丢旧画面比卡内存或迟延渲染合理。
 *
 * detach 在连接断开后调用：回到排队态，否则后续帧会写向已关掉的连接而被静默丢掉。
 */
export function createFrameSink(opts: { maxQueue?: number } = {}): FrameSink {
	const maxQueue = opts.maxQueue ?? 200;
	const queue: Array<{ line: string; control: boolean }> = [];
	let writer: ((line: string) => void) | null = null;
	return {
		push: (frame) => {
			const line = JSON.stringify(frame);
			if (writer) {
				writer(line);
				return;
			}
			queue.push({ line, control: frame.type !== "frame" });
			while (queue.length > maxQueue) {
				const frameIdx = queue.findIndex((entry) => !entry.control);
				queue.splice(frameIdx === -1 ? 0 : frameIdx, 1);
			}
		},
		attach: (write) => {
			writer = write;
			const pending = queue.splice(0, queue.length);
			for (const entry of pending) write(entry.line);
		},
		detach: () => {
			writer = null;
		},
	};
}

export interface TuiHostPatchBridge {
	openCustom: (
		factory: unknown,
		options: unknown,
		ctx: unknown,
	) => Promise<unknown>;
	openWidget: (
		key: string,
		factory: unknown,
		options: unknown,
		ctx: unknown,
	) => void;
	/** 插件清除组件（setWidget(key, undefined)）或改成纯文本：关闭该 key 的 widget 通道 */
	closeWidget: (key: string) => void;
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
// 初始行数必须与前端 TuiPanel 展开态默认可视行数对齐：展开 380px 高 − 标题栏
// ≈ 350px，按前端行高 CELL.height=19.4px 折算约 18 行，取 17 保守值（帧宁可比
// 视口矮一行，不可高出一行被裁掉底部）。pi-goal-x 等外部组件的对话框在创建时
// 按该行数做「保头保尾」行数钳制（maxDialogLines 一次算定、不随 resize 重算），
// 基准写大了，长弹窗的选项区（帧尾）会被推出浮窗首屏——「Confirm Goal Draft
// 看不到选项」的根因。用户拖大浮窗后前端 reportTuiSize 会 resize 到真实行数。
const PANEL_ROWS = 17;
const WIDGET_COLS = 80;
const WIDGET_ROWS = 10;
/** widget 的采样节奏，与 panel.ts 的 80ms 一致（采样是唯一的节流点，规格 §4.5） */
const WIDGET_SAMPLE_MS = 80;

/**
 * overlay 降级时给插件的安全句柄：GUI 下 overlay 就是普通浮窗，隐藏/聚焦没有对应动作，
 * 全部 no-op。`isHidden`/`isFocused` 报「面板在显示 / 持有交互」这两个当下真实的状态
 * （降级后没有浮层隐藏态）——取值只影响插件内部的无副作用分支，因为一切变更都是 no-op。
 */
const DEGRADED_OVERLAY_HANDLE: OverlayHandle = {
	hide() {},
	setHidden() {},
	isHidden: () => false,
	focus() {},
	unfocus() {},
	isFocused: () => true,
	getBounds: () => undefined,
};

/**
 * 把 patchUiForTuiHost 的三个接管点落到真实宿主上：
 * custom → createPanelHost（串行队列），setWidget 组件工厂 → createWidgetHost，
 * 输入监听器 → 反转交给 kernel 推来的事件（规格 §4.3/4.4/4.6/4.7）。
 */
export function createPanelBridge(opts: PanelBridgeOptions): PanelBridge {
	const { sink } = opts;
	let seq = 0;
	let disposed = false;
	/** 会话销毁进行中：用于把 close 帧的 reason 区分为 dispose（规格 §4.8），而非用户 cancel */
	let disposing = false;
	let active: { panelId: string; host: PanelHost<unknown> } | null = null;
	/** 同会话同时只开一个面板：并发的 custom 在这里排队（规格 §4.7） */
	const waiting: Array<() => void> = [];
	const widgets = new Map<
		string,
		{ host: WidgetHost; timer: ReturnType<typeof setInterval> }
	>();
	// 持有 Set 引用而不是拷贝：patchUiForTuiHost 先建集合并交给我们，插件随后才 add
	// （onTerminalInput 随时可能被调用），拷贝会让后注册的监听器永远收不到输入。
	let inputListeners = new Set<(data: string) => void>();

	/** 停采样、释放组件并从表里摘掉该 key（不发帧；发不发 close 由调用方决定） */
	const releaseWidget = (key: string): boolean => {
		const existing = widgets.get(key);
		if (!existing) return false;
		clearInterval(existing.timer);
		existing.host.dispose();
		widgets.delete(key);
		return true;
	};

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
			onFrame: (frame) =>
				sink.push({
					type: "frame",
					panelId,
					lines: frame.lines,
					cursor: frame.cursor,
				}),
		});
		active = { panelId, host };
		sink.push({
			type: "open",
			panelId,
			kind: "custom",
			title: PANEL_TITLE,
			cols: PANEL_COLS,
			rows: PANEL_ROWS,
			// 队列深度只在 open 时写一次：入队者变多不会重发 open（前端徽标看不到 >1 的排队数，
			// 要实时反映需要 kernel 支持重发 open，见任务 9 审查的「待记账」项）
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
			// 会话销毁 ≠ 用户取消：两者都回 cancelled，但规格 §4.8 把「会话销毁」列为
			// 独立的终止路径，只有 reason 能区分（前端对 close 的处理不分 reason，只影响语义）。
			const reason = done ? "done" : disposing ? "dispose" : "cancel";
			finish(done ? r.value : undefined, reason);
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
		// options 只用于 widget 的 placement；custom 这边 `options.overlay === true`（覆盖式浮窗，
		// 规格 §4.3）按控制者裁定**有意降级**为普通整屏面板——图形界面下 overlay 与普通浮窗
		// 呈现无差别，因此不再做浮层语义（panel.ts 已预留 showOverlay 钩子，真要接时在那边改）。
		// 但 `onHandle` 必须照常回调（规格 §4.3 原文）：同一个 custom 调用里的插件拿不到句柄，
		// 后续 `handle.hide()` / `setHidden()` 就会抛 TypeError——降级的是浮层语义，不是回调契约。
		// 调用时机是 pi 的超集：pi 只在 `overlay === true` 时回调，这里只要插件提供就回调。
		// GUI 下 overlay 降级为普通浮窗、句柄为 no-op 级安全对象，故不区分 overlay 分支。
		openCustom: (factory, options, _ctx) => {
			const onHandle = (
				options as { onHandle?: (handle: OverlayHandle) => void } | undefined
			)?.onHandle;
			if (typeof onHandle === "function") {
				try {
					onHandle(DEGRADED_OVERLAY_HANDLE);
				} catch {
					/* 插件自己的回调异常不影响面板开启 */
				}
			}
			return new Promise<unknown>((resolve) => {
				const start = () => startPanel(factory, resolve);
				if (active) waiting.push(start);
				else start();
			});
		},

		openWidget: (key, factory, options, _ctx) => {
			// 替换：旧的宿主与采样定时器先释放（规格 §4.4 的「组件被替换时 dispose」）
			releaseWidget(key);
			const host = createWidgetHost({
				cols: WIDGET_COLS,
				factory: factory as never,
				theme: opts.theme as Theme,
			});
			const panelId = `w:${key}`;
			// placement 沿 pi 的 widget 语义（规格 §4.4）：前端 dock 据此决定摆在输入框上方还是下方
			const placement = (
				options as { placement?: "aboveEditor" | "belowEditor" } | undefined
			)?.placement;
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
			// 首次采样当作「工厂是否产出」的校验：widget.ts 的首帧没有去重基线，
			// 组件有效必得帧；工厂抛错或返回 undefined（pi 的签名允许）时会在同一次
			// 调用里补一帧 close，否则前端会挂着一个永不更新的空面板（幽灵面板）。
			// 顺便让首帧与 custom 路径一致地立刻上屏，不必等第一个 80ms 采样点。
			const first = host.sample();
			if (!first) {
				host.dispose();
				sink.push({
					type: "close",
					panelId,
					kind: "widget",
					widgetKey: key,
					reason: "empty",
				});
				return;
			}
			sink.push({
				type: "frame",
				panelId,
				kind: "widget",
				widgetKey: key,
				lines: first.lines,
			});
			const timer = setInterval(() => {
				const frame = host.sample();
				if (frame)
					sink.push({
						type: "frame",
						panelId,
						kind: "widget",
						widgetKey: key,
						lines: frame.lines,
					});
			}, WIDGET_SAMPLE_MS);
			widgets.set(key, { host, timer });
		},

		closeWidget: (key) => {
			// 清除（setWidget(key, undefined)）或内容从组件换成纯文本：前端那块 widget 必须跟着消失
			if (releaseWidget(key)) {
				sink.push({
					type: "close",
					panelId: `w:${key}`,
					kind: "widget",
					widgetKey: key,
					reason: "removed",
				});
			}
		},

		setInputListeners: (listeners) => {
			inputListeners = listeners;
		},

		handleInput: (event) => {
			const panelId = event.panelId;
			// 缺 panelId / 未知 type 一律静默丢弃（无日志）：协议不匹配时不拿日志刷屏，
			// 排查靠任务 6/11 的接口与 E2E 测试（记账项，见任务 9 审查的次要 6）
			if (!panelId) return;
			if (event.type === "cancel") {
				if (active?.panelId === panelId) active.host.cancel();
				return;
			}
			// widget 无焦点、不收键盘/鼠标（规格 §4.4），只接受尺寸变化
			if (panelId.startsWith("w:")) {
				if (event.type === "resize" && typeof event.cols === "number")
					widgets.get(panelId.slice(2))?.host.resize(event.cols);
				return;
			}
			if (active?.panelId !== panelId) return;
			if (event.type === "resize") {
				active.host.resize(event.cols ?? PANEL_COLS, event.rows ?? PANEL_ROWS);
				return;
			}
			if (event.data === undefined) return;
			if (
				event.type === "key" ||
				event.type === "paste" ||
				event.type === "mouse"
			) {
				active.host.inject(event.data);
				// 插件注册的 onTerminalInput 监听器只收按键/粘贴（鼠标序列由 TuiAltScreen 自己解析）
				if (event.type !== "mouse") forwardToListeners(event.data);
			}
		},

		disposeAll: () => {
			disposed = true;
			// 先置位再 dispose：host.dispose() 触发的 result.then 靠它把 reason 判成 dispose
			disposing = true;
			for (const start of waiting.splice(0, waiting.length)) start();
			for (const key of [...widgets.keys()]) releaseWidget(key);
			active?.host.dispose();
			active = null;
		},
	};
}

/**
 * 接管 ui 上下文的三个成员（规格 §4.3/4.4/4.6）。
 *
 * 幂等按**bridge 实例**判定（`__waPiTuiHostBridge`）：同一个 bridge 重复 patch 直接返回，
 * 避免多次 session_start 反复包裹；换了 bridge 就必须重新 patch。
 * 这一点不能只看 ui 上的布尔标记：pi 的 reload 会先发 session_shutdown（扩展据此把
 * bridge 完全丢弃）再用**同一个 uiContext 对象**发 session_start，若只认布尔标记，
 * 新 bridge 会被挡下，ui.custom 仍指向已废弃的旧 bridge（它只会静默 resolve(undefined)），
 * 同时 `__waPiTuiHost` 又让 wa-pi-bridge 的 notify+throw 兜底继续让位——两条路一起失效。
 * 布尔标记 `__waPiTuiHost` 保留：它同时供 wa-pi-bridge 的兜底让位使用。
 */
export function patchUiForTuiHost(
	ui: Record<string, unknown>,
	bridge: TuiHostPatchBridge,
): void {
	if (ui.__waPiTuiHostBridge === bridge) return;
	ui.__waPiTuiHost = true;
	ui.__waPiTuiHostBridge = bridge;

	const originalSetWidget = ui.setWidget as
		| ((key: string, content: unknown, options?: unknown) => void)
		| undefined;
	// 监听器集合跟着 ui 对象走，重新 patch 时沿用同一个集合：否则 reload 前插件注册的
	// onTerminalInput 回调会变成孤儿（pi 自己复用的 uiContext 里这个集合也是跨 session 存续的）。
	const existingListeners = ui.__waPiTuiHostListeners as
		| Set<(data: string) => void>
		| undefined;
	const listeners = existingListeners ?? new Set<(data: string) => void>();
	ui.__waPiTuiHostListeners = listeners;
	bridge.setInputListeners(listeners);

	ui.custom = (factory: unknown, options: unknown, ctx: unknown) =>
		bridge.openCustom(factory, options, ctx);

	ui.setWidget = (key: string, content: unknown, options?: unknown) => {
		if (typeof content === "function") {
			bridge.openWidget(key, content, options, undefined);
			return;
		}
		// 非组件内容就是 pi 的「清除/纯文本」语义：先让旧 widget 通道收尾，再透传原实现。
		// 清除（undefined）时如果不通知 widget 通道，宿主与采样定时器会继续存活，
		// 前端那块面板就永远不会消失（幽灵面板）。
		bridge.closeWidget(key);
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

/** 帧流/输入订阅流共用的连接与重试选项 */
export interface BridgeStreamOptions {
	/** kernel 的 bridge 基址（WA_PI_BRIDGE_URL） */
	bridgeUrl: string;
	token: string;
	sessionId: string;
	/** 正常断流后的重连间隔（规格 §8：帧流/订阅流断开要能恢复） */
	retryMs?: number;
	/** 连续失败时的重连间隔上限（指数退避封顶） */
	maxRetryMs?: number;
	/** 便于单测注入 */
	fetchImpl?: typeof fetch;
	/** 连续失败的日志出口（默认 console.warn），便于单测断言 */
	log?: (message: string) => void;
}

export interface InputChannelOptions extends BridgeStreamOptions {
	onEvent: (event: TuiHostInputEvent) => void;
}

export interface InputChannel {
	start(): void;
	stop(): void;
}

export interface FrameStreamOptions extends BridgeStreamOptions {
	sink: FrameSink;
	/** 空闲期心跳间隔（默认 15s，规格 §5.1），便于单测注入短间隔 */
	heartbeatMs?: number;
}

export interface FrameStream {
	/** 开始（或重启）帧流；重入/重复调用不会建立第二条连接 */
	start(): void;
	/** 停止：停掉重连定时器并优雅结束当前连接（已入队的帧仍会送出） */
	stop(): void;
}

const DEFAULT_RETRY_MS = 1000;
/** 连续失败的重连间隔上限：token 失效（401）等场景不至于无限 1s 轮询 */
const DEFAULT_MAX_RETRY_MS = 5000;
/**
 * 空闲期心跳间隔（规格 §5.1，沿用 bridge-registry 的 handleBridgeStream 参数）：
 * kernel 的 HTTP 服务设了 idleTimeout=255s，静默的长连接会被定时掐断；
 * 面板静止（画面无变化，没有业务帧可发）时靠 ping 帧保活。
 */
const DEFAULT_HEARTBEAT_MS = 15_000;

/** 指数退避：第 failures 次连续失败后的等待时长（base × 2^(failures-1)，封顶 maxMs） */
export function backoffDelay(
	failures: number,
	baseMs: number,
	maxMs: number,
): number {
	const n = Math.max(1, Math.floor(failures));
	return Math.min(baseMs * 2 ** (n - 1), maxMs);
}

const errorText = (err: unknown): string =>
	err instanceof Error ? err.message : String(err);

/** 一次连接尝试：run 返回 null = 正常结束，返回字符串 = 失败原因 */
interface RetryAttempt {
	run(): Promise<string | null>;
	/** stop() 时的即时收尾（无论连接是否已建立） */
	stop?(): void;
	/** 本次尝试结束后的清理（无论成功失败） */
	cleanup?(): void;
}

/**
 * 「连接 → 断开 → 重连」骨架，帧流与输入订阅流共用：
 * - 正常结束（kernel 重启、会话结束）按基准间隔重连，不累计失败；
 * - 失败（网络错、非 2xx）按指数退避重连并打一行日志，避免认证失效场景刷屏；
 * - stop() 停掉定时器并断开当前连接，之后不再重连（不泄定时器）。
 */
function createRetryLoop(opts: {
	label: string;
	sessionId: string;
	retryMs?: number;
	maxRetryMs?: number;
	log?: (message: string) => void;
	connect: () => RetryAttempt;
}): { start(): void; stop(): void } {
	const retryMs = opts.retryMs ?? DEFAULT_RETRY_MS;
	const maxRetryMs = opts.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
	const log = opts.log ?? ((message: string) => console.warn(message));
	let stopped = false;
	let running = false;
	let failures = 0;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let current: RetryAttempt | null = null;

	const run = async (): Promise<void> => {
		if (stopped || running) return;
		running = true;
		const attempt = opts.connect();
		current = attempt;
		let failure: string | null = null;
		try {
			failure = await attempt.run();
		} catch (err) {
			failure = errorText(err);
		} finally {
			current = null;
			running = false;
			attempt.cleanup?.();
		}
		if (stopped) return;
		let delay: number;
		if (failure === null) {
			failures = 0;
			delay = retryMs;
		} else {
			failures += 1;
			delay = backoffDelay(failures, retryMs, maxRetryMs);
			// 退避封顶后日志最多每 maxRetryMs 一行，认证失败等场景不会形成刷屏
			log(
				`[wa-pi-tui-host] ${opts.label}（第 ${failures} 次，session=${opts.sessionId}）：${failure}，${delay}ms 后重连`,
			);
		}
		timer = setTimeout(() => void run(), delay);
	};

	return {
		start: () => {
			stopped = false;
			void run();
		},
		stop: () => {
			stopped = true;
			if (timer) clearTimeout(timer);
			timer = null;
			current?.stop?.();
		},
	};
}

/**
 * 帧流（规格 §5.1）：长连接把 NDJSON 帧写给 kernel，首行是 {token,sessionId} 鉴权，
 * 之后每行一帧；响应要等本连接结束才回来，所以只 await 连接本身。
 *
 * 空闲期按 DEFAULT_HEARTBEAT_MS 发一帧 {type:"ping"} 保活：kernel 侧 idleTimeout=255s
 * 会掐断静默长连接，面板静止时没有业务帧，不发心跳就会被周期性断连重连（重连窗口还丢帧）。
 * ping 无业务含义，kernel 的 applyFrame 静默忽略。
 *
 * 断线期间的帧留在 sink 队列里（规格 §8），重连后 attach 会按序补发。
 */
export function createFrameStream(opts: FrameStreamOptions): FrameStream {
	const fetchImpl = opts.fetchImpl ?? fetch;
	const encoder = new TextEncoder();
	return createRetryLoop({
		label: "帧流连接失败",
		sessionId: opts.sessionId,
		retryMs: opts.retryMs,
		maxRetryMs: opts.maxRetryMs,
		log: opts.log,
		connect: () => {
			let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
			let heartbeat: ReturnType<typeof setInterval> | null = null;
			// 心跳只在本连接存活期间跑：连接结束或 stop 就停表，不向已断开的 sink 推 ping
			const stopHeartbeat = () => {
				if (heartbeat) clearInterval(heartbeat);
				heartbeat = null;
			};
			const body = new ReadableStream<Uint8Array>({
				start(c) {
					controller = c;
					// 首行鉴权：kernel 读到 token/sessionId 后才把后续行当帧处理
					c.enqueue(
						encoder.encode(
							`${JSON.stringify({ token: opts.token, sessionId: opts.sessionId })}\n`,
						),
					);
				},
			});
			opts.sink.attach((line) => {
				try {
					controller?.enqueue(encoder.encode(`${line}\n`));
				} catch {
					// 连接已关：本帧丢弃，重连后 attach 会补发随后入队的帧
				}
			});
			// 经 sink 推 ping 而不是直写 controller：与业务帧共用同一条出口
			heartbeat = setInterval(() => {
				opts.sink.push({ type: "ping" });
			}, opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
			return {
				// 优雅收尾：关掉请求体的写入端，已入队的帧（如 teardown 的 close）随流送达 kernel；
				// 直接 abort 会把这些帧连同连接一起丢掉，前端会留下幽灵面板。
				stop: () => {
					stopHeartbeat();
					// 先摘掉 sink 再关 body：body 关闭后推来的帧必须回到队列等下次 attach 补发，
					// 否则会写进已关的 controller 被 catch 静默吞掉（reload 时 teardown 与下一个
					// session_start 同轮次的话，这些帧就丢了）。已入 body 的帧不受影响。
					opts.sink.detach();
					try {
						controller?.close();
					} catch {
						/* 已关闭 */
					}
				},
				cleanup: () => {
					stopHeartbeat();
					opts.sink.detach();
				},
				run: async () => {
					const res = await fetchImpl(`${opts.bridgeUrl}/bridge/tui-host/frames`, {
						method: "POST",
						// 流式请求体（Bun 1.4.2 实测可用）；duplex 是流式 body 的规范要求，DOM 类型里尚未收录
						duplex: "half",
						headers: { "content-type": "application/x-ndjson" },
						body,
					} as RequestInit);
					if (res.ok) return null;
					// 非 2xx（如 token 失效 401）要读掉响应体释放连接
					await res.text().catch(() => "");
					return `HTTP ${res.status}`;
				},
			};
		},
	});
}

/**
 * 订阅 kernel 的输入流（规格 §5.2）：POST /bridge/tui-host/subscribe 的 NDJSON
 * 响应里逐行给出按键/粘贴/鼠标/尺寸/取消事件，交给 onEvent 路由到对应宿主。
 *
 * 取舍：断流只重试、不抛——pi 的主循环不能被扩展的网络问题打断；kernel 在无订阅者
 * 时会把输入排队，重连后自动补发（规格 §6.1）。
 */
export function connectInputChannel(opts: InputChannelOptions): InputChannel {
	const fetchImpl = opts.fetchImpl ?? fetch;
	return createRetryLoop({
		label: "输入订阅连接失败",
		sessionId: opts.sessionId,
		retryMs: opts.retryMs,
		maxRetryMs: opts.maxRetryMs,
		log: opts.log,
		connect: () => {
			const abort = new AbortController();
			return {
				stop: () => abort.abort(),
				run: async (): Promise<string | null> => {
					let res: Response;
					try {
						res = await fetchImpl(`${opts.bridgeUrl}/bridge/tui-host/subscribe`, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ token: opts.token, sessionId: opts.sessionId }),
							signal: abort.signal,
						});
					} catch (err) {
						return errorText(err);
					}
					if (!res.ok) {
						await res.text().catch(() => "");
						return `HTTP ${res.status}`;
					}
					if (!res.body) return "响应没有流式 body";
					const reader = res.body.getReader();
					const decoder = new TextDecoder();
					let rest = "";
					try {
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
					} catch (err) {
						return `读取流失败：${errorText(err)}`;
					}
					return null; // 流正常结束
				},
			};
		},
	});
}
