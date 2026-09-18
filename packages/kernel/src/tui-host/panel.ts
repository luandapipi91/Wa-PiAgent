import { TuiAltScreen, type Component } from "@earendil-works/pi-tui";
// 这两个类型取自 pi-coding-agent，而不是 pi-tui：factory 第 3 个参数的类型由 pi 的 custom 签名决定
// （pi-coding-agent/dist/core/extensions/types.d.ts:117 的形参就是它 re-export 的 KeybindingsManager，
// 即 pi-tui 基类的子类）。pi-tui 0.85.1 确实有 KeybindingsManager 导出
// （pi-tui/dist/index.d.ts:21），但把基类实例赋给该形参实测报 TS2739，所以类型来源不能改回 pi-tui。
// Theme 则根本不在 pi-tui 的导出里，只能从 pi-coding-agent 取。`import type` 会被擦除，无运行时代价。
import type {
	KeybindingsManager,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { WaPiFakeTerminal } from "./terminal.ts";
import { extractFrame, sameFrame, type TuiFrame } from "./frame.ts";
import { resolveClickKeys, translateMouseRow } from "./click.ts";

export type PanelResult<T> =
	| { status: "done"; value: T }
	| { status: "cancelled" };

export interface PanelHostOptions<T> {
	/** 面板标题：宿主本身不消费，由任务 9 写进 open 帧的元数据（规格 §5.1） */
	title: string;
	cols: number;
	rows: number;
	/** pi 传来的组件工厂；第 4 个参数是 pi 的 done 回调 */
	factory: (
		tui: TuiAltScreen,
		theme: Theme,
		keybindings: KeybindingsManager,
		done: (result: T) => void,
	) => Component | Promise<Component>;
	theme: Theme;
	keybindings: KeybindingsManager;
	/**
	 * 拖选复制：接前端剪贴板（规格 §4.3 / §7.5）。
	 * 缺省时构造里**不传**该字段（而不是传一个返回 false 的 no-op）——见构造处注释。
	 */
	copySelection?: (text: string) => Promise<boolean>;
	/** 点击 OSC 8 超链接：接系统浏览器（规格 §4.3 / §7.5）。缺省时为 no-op */
	openUrl?: (url: string) => void;
	/**
	 * 覆盖式浮窗：来自 pi 的 custom options（规格 §4.3），true 时应改用同一实例的
	 * `tui.showOverlay(component, overlayOptions)`。本任务只存字段，addChild/overlay 分支留给任务 9。
	 */
	overlay?: boolean;
	/** 传给 `tui.showOverlay` 的定位/尺寸选项（规格 §4.3，来自 pi 的 custom options）；本任务仅存字段 */
	overlayOptions?: unknown;
	/** overlay 句柄回调（规格 §4.3，来自 pi 的 custom options）；本任务仅存字段 */
	onHandle?: (handle: unknown) => void;
	/** 帧变化回调（由 host.ts 接到 kernel 帧流上）；抛错会被吞掉，不得依赖它传播错误 */
	onFrame?: (frame: TuiFrame) => void;
}

export interface PanelHost<T> {
	readonly result: Promise<PanelResult<T>>;
	/** 启动 TUI（调 terminal.start，拿到 onInput 回调） */
	start(): void;
	/** 采一帧；内容与上次相同返回 null（不推送） */
	sample(): TuiFrame | null;
	inject(data: string): void;
	resize(cols: number, rows: number): void;
	/** 用户点 ✕：回 cancelled */
	cancel(): void;
	/** 关闭并清理（幂等）；未结束时以 cancelled 结束 */
	dispose(): void;
}

const SAMPLE_INTERVAL_MS = 80;

/** pi 的组件可以带 dispose，但 pi-tui 的 Component 契约里没有 */
type DisposableComponent = Component & { dispose?: () => void };

/**
 * 给**没有**鼠标能力的组件补一个「点击 → 键盘」回退（规格 §4.8 的鼠标钩子的兜底面）。
 *
 * pi-tui 的鼠标分发只对实现了 `handleMouse` 的组件生效，自定义对话框
 * （如 pi-goal-x 的问卷）只实现 `handleInput`——用户点选项行会落到 alt-screen
 * 的文本选择逻辑，表现为「按钮点不到」。这里在组件未消费鼠标时按帧文本推断
 * 等价的键盘序列（见 click.ts），推不出就什么都不做。
 *
 * 只补齐、不覆盖：插件自带 handleMouse 时原样保留（那才是它的原生语义）。
 */
function attachClickFallback(component: Component, terminal: WaPiFakeTerminal): void {
	if (typeof component.handleMouse === "function") return;
	component.handleMouse = (event) => {
		// 只在真正的「点击」上动作：按下/松开要留给拖选（复制路径靠它）
		if (event.type !== "click") return undefined;
		let lines: string[];
		try {
			// 用组件自己的渲染行 + 事件的行内坐标定位：与屏幕偏移无关（浮窗/缩放都不会错行）
			lines = component.render(terminal.columns);
		} catch {
			return undefined;
		}
		const keys = resolveClickKeys(lines, event.y);
		if (!keys) return undefined;
		// 逐键注入：假终端的 inject 是「一整个字符串交给 focusedComponent」，
		// 拼成一串会让 pi-tui 的 matchesKey 一个键也解析不出来
		for (const key of keys) terminal.inject(key);
		return { handled: true };
	};
}

/** 工厂可能同步返回组件，也可能返回 Promise<组件> */
function isThenable(
	value: Component | Promise<Component>,
): value is Promise<Component> {
	return typeof (value as { then?: unknown }).then === "function";
}

/**
 * 面板宿主：假 Terminal + TuiAltScreen + 采样循环。
 *
 * 采样是唯一的节流点（规格 §4.5）：定时取整帧，内容相同不回调。
 * 生命周期保证 result 必然 settle（done / cancel / dispose / factory 抛错），
 * 绝不留挂起 Promise —— 这是历史上 custom() 挂死的根因，必须守住。
 */
export function createPanelHost<T>(opts: PanelHostOptions<T>): PanelHost<T> {
	const terminal = new WaPiFakeTerminal({ cols: opts.cols, rows: opts.rows });
	// 构造时就带上「非标准终端宿主」的钩子（规格 §4.8 打开行）：鼠标/滚轮/剪贴板/超链接，
	// 任务 9 直接把前端剪贴板与系统浏览器接上来即可，不必回头改本文件。
	const tui = new TuiAltScreen(terminal, false, undefined, {
		mouse: true,
		wheelScrollLines: 3,
		openUrl: opts.openUrl ?? (() => {}),
		// copySelection 只在调用方显式提供时才传。pi-tui 的 copyTextToClipboard 语义是
		// 「未提供（字段为假值）才回退到 OSC 52 写」（规格 §7.5：「若未提供 copySelection，
		// TuiAltScreen 会回退到 OSC 52 写，前端可用 \x1b]52;... 解析兜底」）。
		// 因此缺省传一个返回 false 的 no-op 会把这层兜底关掉——拖选复制会直接落到
		// 「Copy failed」而无论如何都写不出 OSC 52，所以这里必须留 undefined。
		...(opts.copySelection ? { copySelection: opts.copySelection } : {}),
	});

	let settled = false;
	let resolveResult!: (r: PanelResult<T>) => void;
	const result = new Promise<PanelResult<T>>((r) => {
		resolveResult = r;
	});

	let lastFrame: TuiFrame | null = null;
	let component: DisposableComponent | null = null;
	let started = false;
	let timer: ReturnType<typeof setInterval> | null = null;

	const settle = (r: PanelResult<T>) => {
		if (settled) return;
		settled = true;
		resolveResult(r);
	};

	const stopTimer = () => {
		if (timer) clearInterval(timer);
		timer = null;
	};

	const safeDispose = (c: DisposableComponent) => {
		try {
			c.dispose?.();
		} catch {
			/* 组件自身清理异常不影响收尾 */
		}
	};

	/** 关闭：停采样、停 TUI（先于组件释放，让 stop 的收尾渲染仍能看到组件）、释放组件 */
	const teardown = () => {
		stopTimer();
		try {
			tui.stop();
		} catch {
			/* 未 start 时 stop 可能抛错，忽略 */
		}
		if (component) safeDispose(component);
		component = null;
		terminal.stop();
	};

	/** 挂载组件、启动 TUI 与定时采样 */
	const mount = (c: Component) => {
		component = c;
		attachClickFallback(c, terminal);
		tui.addChild(c);
		// TuiBase 只把键盘输入交给 focusedComponent，不设焦点 inject 的按键就到不了组件
		tui.setFocus(c);
		tui.start();
		stopTimer();
		timer = setInterval(() => sample(), SAMPLE_INTERVAL_MS);
	};

	/** 启动 TUI；幂等。同步返回的工厂立即挂载（首帧即可采样），thenable 才等异步到达 */
	const ensureStarted = () => {
		if (started || settled) return;
		started = true;

		let created: Component | Promise<Component>;
		try {
			created = opts.factory(tui, opts.theme, opts.keybindings, (value: T) => {
				teardown();
				settle({ status: "done", value });
			});
		} catch {
			settle({ status: "cancelled" });
			return;
		}

		if (!isThenable(created)) {
			if (settled) {
				// 工厂在返回前就调了 done：组件已无宿主，直接释放
				safeDispose(created);
				return;
			}
			mount(created);
			return;
		}

		void Promise.resolve(created)
			.then((c) => {
				if (settled) {
					safeDispose(c);
					return;
				}
				mount(c);
				renderFrame();
			})
			.catch(() => {
				settle({ status: "cancelled" });
			});
	};

	/** 取整帧并推送变化；内容与上次相同则返回 null */
	function renderFrame(): TuiFrame | null {
		if (settled || !component) return null;
		let frame: TuiFrame;
		try {
			// 整屏契约：TuiAltScreen.render(width) 渲染挂载的组件树
			frame = extractFrame(tui.render(terminal.columns));
		} catch {
			// 组件渲染异常：关闭面板并回 cancelled，避免把异常抛回 pi 的调用栈
			dispose();
			return null;
		}
		if (sameFrame(lastFrame, frame)) return null;
		lastFrame = frame;
		try {
			opts.onFrame?.(frame);
		} catch {
			// 推送通道（任务 9 接 kernel 帧流）异常不得让采样循环变成未捕获异常；
			// 帧已记为上一帧，通道恢复后靠调用方补发，宿主不重复推送
		}
		return frame;
	}

	const sample = (): TuiFrame | null => {
		// 未显式 start 也会懒启动：面板的第一次采样就该拿到内容
		ensureStarted();
		return renderFrame();
	};

	const dispose = () => {
		teardown();
		settle({ status: "cancelled" });
	};

	return {
		result,
		start: () => {
			ensureStarted();
			renderFrame();
		},
		sample,
		// 启动之前注入的按键会被假 Terminal 丢弃（TUI 尚未 start，onInput 回调还没注册）；
		// 需要早注入的场景由调用方先 start()，这里不做缓存队列
		inject: (data) => {
			// 鼠标是「帧行」座标（前端只知道自己显示的那一帧），pi-tui 要「终端视口行」：
			// 在入端折算（见 click.ts），折算后落在视口外的点击丢掉，不挪到别的行上去
			const viewport = translateMouseRow(
				data,
				lastFrame?.lines.length ?? terminal.rows,
				terminal.rows,
			);
			if (viewport !== null) terminal.inject(viewport);
		},
		// 只更新假 Terminal 的尺寸，不在此处立即采样：这是对规格 §4.5「尺寸变化触发一次采样」的有意偏离——
		// 定时器最多 80ms 内就会取到新宽度（用户不可感知），而立即采样会让拖动缩放时每个宽度变化都多渲染一次组件。
		resize: (cols, rows) => terminal.resize(cols, rows),
		cancel: dispose,
		dispose,
	};
}
