import type { Component, TUI } from "@earendil-works/pi-tui";
// Theme 取自 pi-coding-agent 而不是 pi-tui：pi-tui 0.85.1 的 index.d.ts 里根本没有 Theme 导出
// （pi-coding-agent/dist/index.d.ts:29 才是它 re-export 的来源）。widget 工厂的第 2 个形参
// 正是这个 Theme（pi-coding-agent/dist/core/extensions/types.d.ts 的 setWidget 重载），
// 所以类型来源必须与 pi 的签名一致。`import type` 会被擦除，无运行时代价。
import type { Theme } from "@earendil-works/pi-coding-agent";
import { extractFrame, sameFrame, type TuiFrame } from "./frame.ts";

export interface WidgetHostOptions {
	cols: number;
	/** pi 的 widget 组件工厂：只收 (tui, theme) */
	factory: (tui: TUI, theme: Theme) => Component & { dispose?(): void };
	theme: Theme;
	onFrame?: (frame: TuiFrame) => void;
}

export interface WidgetHost {
	start(): void;
	sample(): TuiFrame | null;
	resize(cols: number): void;
	dispose(): void;
}

/**
 * 哑 TUI：widget 组件按 pi 语义无焦点、无输入，只需要一个能承受
 * requestRender/invalidate 调用的对象。
 *
 * 不引入真实 TUI 实例的理由：真 TUI 会启动渲染循环并写终端字节，
 * 对一个纯展示的小块而言全是开销；这里只要 render(width) 的结果。
 */
function createDumbTui(onInvalidate: () => void): TUI {
	const dumb = {
		requestRender: () => onInvalidate(),
		invalidate: () => onInvalidate(),
		setFocus: () => {},
		getFocusedComponent: () => null,
		addChild: () => {},
		removeChild: () => {},
		addInputListener: () => () => {},
		removeInputListener: () => {},
		showOverlay: () => ({ hide: () => {}, setHidden: () => {}, isHidden: () => true }),
		hideOverlay: () => {},
		hasOverlay: () => false,
	};
	return dumb as unknown as TUI;
}

/**
 * widget 宿主：驱动 `setWidget(key, factory, options)` 的组件分支。
 *
 * 帧采集与 custom 共用 frame.ts；组件抛错一律吞掉并返回 null，
 * 避免扩展的渲染异常污染 pi 的主循环。
 */
export function createWidgetHost(opts: WidgetHostOptions): WidgetHost {
	let cols = Math.max(20, Math.floor(opts.cols));
	let component: (Component & { dispose?(): void }) | null = null;
	let lastFrame: TuiFrame | null = null;
	let started = false;
	const dumbTui = createDumbTui(() => {
		/* 组件请求重绘：采样由 host.ts 的定时器驱动，这里只作为信号来源 */
	});

	const start = () => {
		if (started) return;
		started = true;
		try {
			component = opts.factory(dumbTui, opts.theme);
		} catch {
			component = null;
		}
	};

	const sample = (): TuiFrame | null => {
		if (!component) return null;
		let frame: TuiFrame;
		try {
			frame = extractFrame(component.render(cols));
		} catch {
			return null;
		}
		if (sameFrame(lastFrame, frame)) return null;
		lastFrame = frame;
		opts.onFrame?.(frame);
		return frame;
	};

	return {
		start,
		sample,
		resize: (next: number) => {
			cols = Math.max(20, Math.floor(next));
		},
		dispose: () => {
			try {
				component?.dispose?.();
			} catch {
				/* 组件清理异常不影响收尾 */
			}
			component = null;
		},
	};
}
