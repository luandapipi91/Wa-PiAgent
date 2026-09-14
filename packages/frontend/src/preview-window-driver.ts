import { useEffect } from "react";
import { useBrowserStore } from "./store/browser";
import { useSettingsStore, type SettingsSection } from "./store/settings";
import type { PreviewWinEvent } from "./preview-window";

/**
 * 主窗口侧的独立预览窗口驱动（在 App 顶层挂载一次）。
 *
 * 职责边界：
 * - 窗口的存在性/显示状态由本 hook 下发指令，主进程只负责执行——状态的权威仍在渲染层 store；
 * - 独立窗口上报的动作（最小化/关闭/切回内嵌/元素回传）在这里翻译成 store 变更与插入事件；
 * - 独立窗口自己的 store 是另一个实例，内容同步靠主进程转发 sync 消息（见 PreviewWindowRoot）。
 *
 * 抽成 hook 而非写在 App 内联 effect：App 体量大且依赖繁多，这里可独立单测。
 */
export function usePreviewWindowDriver(): void {
	const open = useBrowserStore((s) => s.open);
	const mode = useBrowserStore((s) => s.mode);
	const minimized = useBrowserStore((s) => s.minimized);
	const path = useBrowserStore((s) => s.path);
	const sessionId = useBrowserStore((s) => s.sessionId);

	// 独立窗口 → 主窗口：动作翻译成 store 变更 / 插入事件
	useEffect(() => {
		const api = window.waPiPreviewWin;
		if (!api) return;
		return api.onEvent((e: PreviewWinEvent) => {
			const store = useBrowserStore.getState();
			switch (e.type) {
				case "minimized":
					store.setMinimized(true);
					break;
				case "close":
					// 独立窗口里点关闭 = 关闭预览（清该会话的预览记忆，与内嵌模式同语义）
					store.closeBrowser();
					break;
				case "mode":
					store.setMode(e.mode);
					break;
				case "rect":
					// 窗口被挪动/缩放：屏幕坐标持久化，下次弹出回到原位
					store.setDetachedRect(e.rect);
					break;
				case "element":
					// 转发来的裸 token 补前后空格（与内嵌路径 sendElementToChat 口径一致）
					window.dispatchEvent(
						new CustomEvent("wa-pi:insert-mention", {
							detail: { text: ` ${e.token} ` },
						}),
					);
					break;
				case "open-settings":
					// 独立窗口请主窗口打开设置：设置弹窗只在主窗口（数据/上下文都在那边）
					useSettingsStore.getState().open();
					useSettingsStore.getState().setSection(e.section as SettingsSection);
					break;
				case "closed":
					// 兜底：窗口被关掉但仍自称处于浮动模式（如窗口被外部关闭）→ 收尾为关闭预览。
					// 走正常路径（切模式/关闭预览）时 store 已经更新，这里不会重复动作。
					if (store.open && store.mode === "float") store.closeBrowser();
					break;
				default:
					break;
			}
		});
	}, []);

	// 窗口存在性：浮动模式 + 预览打开 → 开窗（主进程幂等，已存在则只同步内容）；
	// 其它情况一律要求关窗（主进程无窗口时忽略）。restore token 只在开窗时读一次，
	// 避免拖动/缩放窗口导致的 rect 变化反复触发开窗聚焦。
	useEffect(() => {
		const api = window.waPiPreviewWin;
		if (!api) return;
		if (open && mode === "float") {
			void api.open({
				path,
				sessionId,
				rect: useBrowserStore.getState().detachedRect,
			});
		} else {
			api.cmd({ type: "close" });
		}
	}, [open, mode, path, sessionId]);

	// 最小化/恢复：最小化时隐藏窗口（主窗口渲染气泡），恢复时显示并聚焦
	useEffect(() => {
		const api = window.waPiPreviewWin;
		if (!api) return;
		if (!(open && mode === "float")) return;
		api.cmd({ type: minimized ? "hide" : "restore" });
	}, [minimized, open, mode]);
}
