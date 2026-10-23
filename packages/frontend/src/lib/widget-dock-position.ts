/**
 * 收缩态 TUI chip 队列（ExtWidgetDock）的拖动位移：几何约束 + 本地持久化。
 *
 * 位置用「相对默认位置的偏移」表达（CSS `transform: translate(x, y)`），
 * 默认定位（`absolute bottom-full` 贴 Composer 上沿、靠右）不改，避免破坏布局；
 * 拖动结束后写入 localStorage，刷新页面 / 切换会话后恢复。
 */

/** localStorage 键（带项目前缀，避免与同域其他应用冲突） */
export const DOCK_STORAGE_KEY = "wa-pi:ext-widget-dock-offset";

/** 默认偏移：从未拖动过 */
export const DEFAULT_DOCK_OFFSET: DockOffset = { x: 0, y: 0 };

/** 拖动安全边距（px）：避免 chip 贴死聊天区/输入框边缘 */
export const DOCK_MARGIN = 4;

export interface DockOffset {
	x: number;
	y: number;
}

/** 偏移的合法范围（闭区间） */
export interface DockBounds {
	minX: number;
	maxX: number;
	minY: number;
	maxY: number;
}

/** 可视坐标矩形（取自 getBoundingClientRect） */
export interface DockRect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

function finiteOrZero(n: number): number {
	return Number.isFinite(n) ? n : 0;
}

/**
 * 把偏移夹进 bounds。越界取边界值；尺寸为 0（min === max）时取该值；
 * 非有限值按 0 参与计算。bounds 反向（min > max，可活动区域比 chip 还窄）时取 min。
 */
export function clampDockOffset(
	offset: DockOffset,
	bounds: DockBounds,
): DockOffset {
	const x = finiteOrZero(offset.x);
	const y = finiteOrZero(offset.y);
	return {
		x: Math.min(bounds.maxX, Math.max(bounds.minX, x)),
		y: Math.min(bounds.maxY, Math.max(bounds.minY, y)),
	};
}

/**
 * 由 chip 队列「未拖动的默认矩形」与「可活动区域矩形」算出偏移范围。
 *
 * base：chip 队列默认位置矩形；container：允许活动的可视区域
 * （聊天列左右/上沿，下沿取 Composer 上沿 → 保证不盖住输入框）。
 */
export function computeDockBounds(
	base: DockRect,
	container: DockRect,
	margin: number = DOCK_MARGIN,
): DockBounds {
	return {
		minX: container.left + margin - base.left,
		maxX: container.right - margin - base.right,
		minY: container.top + margin - base.top,
		maxY: container.bottom - margin - base.bottom,
	};
}

/**
 * 读取持久化偏移。无记录 / JSON 损坏 / 字段缺失或非数值 / localStorage 抛错
 * → 一律回退默认偏移，且不抛错。
 */
export function loadDockOffset(): DockOffset {
	try {
		const raw = localStorage.getItem(DOCK_STORAGE_KEY);
		if (!raw) return { ...DEFAULT_DOCK_OFFSET };
		const parsed = JSON.parse(raw) as Partial<DockOffset> | null;
		if (
			!parsed ||
			typeof parsed !== "object" ||
			!Number.isFinite(parsed.x) ||
			!Number.isFinite(parsed.y)
		) {
			return { ...DEFAULT_DOCK_OFFSET };
		}
		return { x: parsed.x as number, y: parsed.y as number };
	} catch {
		return { ...DEFAULT_DOCK_OFFSET };
	}
}

/** 写入持久化偏移；localStorage 不可用时静默降级。 */
export function saveDockOffset(offset: DockOffset): void {
	try {
		localStorage.setItem(
			DOCK_STORAGE_KEY,
			JSON.stringify({
				x: finiteOrZero(offset.x),
				y: finiteOrZero(offset.y),
			}),
		);
	} catch {
		/* localStorage 不可用时静默降级 */
	}
}
