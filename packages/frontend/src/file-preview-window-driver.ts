import { useEffect } from "react";
import { useSessionStore } from "./store/session";
import { useSettingsStore, type SettingsSection } from "./store/settings";
import type { FilePreviewWinEvent } from "./preview-window";

/**
 * 文件预览独立窗口驱动（主窗口侧，在 App 顶层挂载一次）。
 *
 * 与 usePreviewWindowDriver 平行：数据源是 sessionStore.filePreview，桥是
 * waPiFilePreviewWin（filepreviewwin:* 通道）。职责边界同款——窗口的存在性由本
 * hook 下发指令、主进程只负责执行；独立窗口自己的 store 是另一个实例，内容同步
 * 靠主进程转发消息。本期无最小化、无文件改动自动刷新（规格非目标）。
 */

const FILE_PREVIEW_RECT_KEY = "waPiFilePreviewDetachedRect";

export type DetachedRect = { x: number; y: number; w: number; h: number };

function isValidRect(r: unknown): r is DetachedRect {
	if (!r || typeof r !== "object") return false;
	const o = r as Record<string, unknown>;
	return [o.x, o.y, o.w, o.h].every(
		(n) => typeof n === "number" && Number.isFinite(n),
	);
}

/** 读取上次持久化的文件窗口位置尺寸（屏幕坐标）；无记录/损坏返回 null。 */
export function loadFilePreviewDetachedRect(): DetachedRect | null {
	try {
		const raw = localStorage.getItem(FILE_PREVIEW_RECT_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		return isValidRect(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** 持久化文件窗口位置尺寸（窗口被拖动/缩放时由 driver 回写）。 */
export function saveFilePreviewDetachedRect(rect: DetachedRect): void {
	try {
		localStorage.setItem(FILE_PREVIEW_RECT_KEY, JSON.stringify(rect));
	} catch {
		/* 存不进去就放弃记忆，不影响功能 */
	}
}

export function useFilePreviewWindowDriver(): void {
	const filePreview = useSessionStore((s) => s.filePreview);

	// 独立窗口 → 主窗口：动作翻译成 store 变更
	useEffect(() => {
		const api = window.waPiFilePreviewWin;
		if (!api) return;
		return api.onEvent((e: FilePreviewWinEvent) => {
			const store = useSessionStore.getState();
			switch (e.type) {
				case "rect":
					// 窗口被挪动/缩放：屏幕坐标持久化，下次弹出回到原位
					if (isValidRect(e.rect)) saveFilePreviewDetachedRect(e.rect);
					break;
				case "closed":
					// 兜底：窗口被外部关闭（正常关闭路径 store 已清空，这里幂等不重复动作）
					if (store.filePreview) store.closeFilePreview();
					break;
				case "path":
					// 窗口内点了 md 相对链接换了文件：同步主窗口 store。
					// openFilePreview 自身幂等（同 path+sessionId 不产生变更），
					// driver 不会再因同值触发 open——回环在这里自然终止。
					store.openFilePreview(
						e.path,
						e.sessionId ?? store.filePreview?.sessionId ?? "",
					);
					break;
				case "open-settings":
					// 独立窗口请主窗口打开设置：设置弹窗只在主窗口（数据/上下文都在那边）
					useSettingsStore.getState().open();
					useSettingsStore.getState().setSection(e.section as SettingsSection);
					break;
				case "sync":
				default:
					// sync 由文件窗口自消费（换内容重读文件），主窗口侧无需动作
					break;
			}
		});
	}, []);

	// 窗口存在性：filePreview 非空 → 开窗（主进程幂等，已存在则只 sync 换内容）；
	// 清空 → 要求关窗（主进程对无窗口场景静默忽略）。无桥（纯浏览器）两分支都不动作，
	// Modal 浮层照旧承载（FilePreviewModal 仅无桥时渲染）。
	useEffect(() => {
		const api = window.waPiFilePreviewWin;
		if (!api) return;
		if (filePreview) {
			void api.open({
				path: filePreview.path,
				sessionId: filePreview.sessionId,
				rect: loadFilePreviewDetachedRect(),
			});
		} else {
			api.cmd({ type: "close" });
		}
	}, [filePreview?.path, filePreview?.sessionId]);
}
