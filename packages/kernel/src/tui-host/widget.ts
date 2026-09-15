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
		showOverlay: () => ({
			hide: () => {},
			setHidden: () => {},
			isHidden: () => true,
		}),
		hideOverlay: () => {},
		hasOverlay: () => false,
	};
	// SAFETY: 哑 TUI 只被组件当绘制信号口用（requestRender/invalidate 触发采样），焦点/子组件/
	// 输入/浮层这几个成员补的是空实现；本宿主只取 render(width) 的结果、不跑真实渲染循环，
	// 故 TUI 上未被实现的其余成员不会被访问（理由见上面「哑 TUI」段）。
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
		try {
			opts.onFrame?.(frame);
			// 推送成功后才推进去重基线（与 panel.ts:202-208 的「先记帧后推送」不同）：
			// 取舍是「宁可重发，不可丢帧」——通道抛错时这一帧不会被永久去重掉，
			// 下次采样会连同后续变化一起重试推送（at-least-once），
			// 代价是通道持续失败时会反复尝试推送同一帧。
			lastFrame = frame;
		} catch {
			// 推送通道（任务 9 接 kernel 帧流）抛错不得逃逸到 pi 主循环：
			// 采样循环必须活着，即使这一帧推失败也照常把帧交给调用方
		}
		return frame;
	};

	return {
		start,
		sample,
		resize: (next: number) => {
			// 非有限值（NaN / Infinity）直接忽略、保持旧宽度：
			// 否则 Math.floor(NaN) 会把 NaN 原样透传给组件渲染（任务 1 已在尺寸上踩过同类坑）
			if (!Number.isFinite(next)) return;
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
