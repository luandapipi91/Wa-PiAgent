import { useEffect } from "react";
import type { PreviewOpenEvent } from "@wa-pi/shared";
import { onEventType } from "./events";
import { useBrowserStore } from "./store/browser";
import { useProjectsStore } from "./store/projects";

/**
 * agent 请求打开预览（`preview:open`，kernel 经 SSE 广播）的前端接线（在 App 顶层挂载一次）。
 *
 * 语义按「事件归属会话」分流：
 * - 事件会话 = 用户当前所在会话 → 立即打开（外部网址走 openExternal、本地 html 走 openBrowser）；
 * - 事件会话 ≠ 当前会话 → 只把内容记入该会话的预览记忆（bySession），不动当前显示，
 *   用户切回该会话时由 activateSession 恢复——避免后台会话的预览请求抢走用户当前画面。
 *
 * useEffect 返回 onEventType 的取消订阅函数：组件卸载即清理，不残留监听器。
 */
export function useAgentPreviewOpener(): void {
	useEffect(
		() =>
			onEventType("preview:open", (event) => {
				const e = event as PreviewOpenEvent;
				// 防御：字段缺失的事件直接忽略（kernel 侧已保证结构，此处不因坏帧崩掉整条分发链）
				if (!e?.sessionId || !e.target) return;
				const store = useBrowserStore.getState();
				const isCurrent =
					useProjectsStore.getState().currentSessionId === e.sessionId;
				if (e.target.kind === "url") {
					if (isCurrent) store.openExternal(e.target.url, e.sessionId);
					else store.rememberSessionPreview(e.sessionId, { url: e.target.url });
					return;
				}
				if (isCurrent) store.openBrowser(e.target.path, e.sessionId);
				else store.rememberSessionPreview(e.sessionId, { path: e.target.path });
			}),
		[],
	);
}
