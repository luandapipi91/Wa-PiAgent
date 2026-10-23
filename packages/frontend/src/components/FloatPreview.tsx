import { FloatBubble } from "./FloatBubble";
import { useBrowserStore } from "../store/browser";

/**
 * 浮动预览的主窗口侧宿主。
 *
 * 浮动模式的呈现已改由独立系统窗口承担（见 PreviewWindowRoot）：预览面板能移出主窗口、
 * 与主窗口并行显示，不再受主窗口边界限制。因此主窗口这里只剩最小化后的气泡入口——
 * 点气泡恢复独立窗口。
 *
 * 窗口的开/关/显示不放在本组件的生命周期里：预览被关闭（open=false）时本组件先卸载，
 * 那时仍需向主进程收尾关窗，所以统一由 App 侧的 effect 驱动。
 */
export function FloatPreview() {
	const minimized = useBrowserStore((s) => s.minimized);
	const bubblePos = useBrowserStore((s) => s.bubblePos);

	if (!minimized) return null;
	return (
		<FloatBubble
			pos={bubblePos}
			onPosChange={(p) => useBrowserStore.getState().setBubblePos(p)}
			// 恢复独立窗口由 App 侧 effect 响应 minimized 变化后下发（cmd restore）
			onRestore={() => useBrowserStore.getState().setMinimized(false)}
		/>
	);
}
