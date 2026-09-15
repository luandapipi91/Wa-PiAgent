import { TuiAltScreen, type Component } from "@earendil-works/pi-tui";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { WaPiFakeTerminal } from "./terminal.ts";
import { extractFrame, sameFrame, type TuiFrame } from "./frame.ts";

export type PanelResult<T> = { status: "done"; value: T } | { status: "cancelled" };

export interface PanelHostOptions<T> {
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
	/** 帧变化回调（由 host.ts 接到 kernel 帧流上） */
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

/** 工厂可能同步返回组件，也可能返回 Promise<组件> */
function isThenable(value: Component | Promise<Component>): value is Promise<Component> {
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
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true, wheelScrollLines: 3 });

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
		opts.onFrame?.(frame);
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
		inject: (data) => terminal.inject(data),
		resize: (cols, rows) => terminal.resize(cols, rows),
		cancel: dispose,
		dispose,
	};
}
