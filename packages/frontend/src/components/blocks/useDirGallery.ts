// 同目录画廊加载：打开媒体预览时，把 items 从「消息里扫到的媒体集合」换成
// 「当前文件所在目录下的媒体清单」（图片 + 视频，文件名自然序）。
// 无法确定可列目录时（远程 URL / 粘贴的图 / 目录在项目工作区之外 / 列举失败）
// 回退为只显示当前这一张。
import { useEffect } from "react";
import { listDir } from "../../fs-client";
import { useProjectsStore } from "../../store/projects";
import { useSessionStore } from "../../store/session";
import { resolveAbsolutePath } from "./FilePill";
import {
	dirOf,
	indexOfPath,
	isInAnyCwd,
	mediaItemsFromEntries,
	sameItems,
} from "./dir-gallery";
import type { MediaItem } from "./media-utils";

function isRemote(src: string): boolean {
	return /^(https?:|data:|blob:)/i.test(src);
}

/** 在 MediaPreviewModal 内调用：每次打开（openId 变化）按同目录重建画廊清单 */
export function useDirGallery(): void {
	const openId = useSessionStore((s) => s.mediaPreview?.openId ?? null);

	useEffect(() => {
		if (openId === null) return;
		const preview = useSessionStore.getState().mediaPreview;
		if (!preview) return;
		const current = preview.items[preview.index];
		if (!current) return;
		let cancelled = false;

		// 回写前复核：弹窗已关闭或已重新打开（openId 变了）就丢弃本次结果
		const apply = (items: MediaItem[], index: number) => {
			if (cancelled) return;
			const st = useSessionStore.getState().mediaPreview;
			if (!st || st.openId !== openId) return;
			if (sameItems(st.items, items) && st.index === index) return;
			useSessionStore.getState().setMediaPreviewItems(items, index);
		};
		const fallbackToCurrent = () => apply([current], 0);

		if (isRemote(current.src)) {
			fallbackToCurrent();
			return;
		}
		const abs = resolveAbsolutePath(current.src, preview.sessionId);
		if (!abs || isRemote(abs)) {
			fallbackToCurrent();
			return;
		}
		const dir = dirOf(abs);
		const cwds = useProjectsStore
			.getState()
			.projects.map((p) => p.cwd)
			.filter(Boolean);
		// 工作区之外的目录：列得出来也渲染不了（内核 /file 白名单），直接回退
		if (!dir || !isInAnyCwd(dir, cwds)) {
			fallbackToCurrent();
			return;
		}

		void listDir(dir)
			.then((entries) => {
				const items = mediaItemsFromEntries(dir, entries);
				if (items.length === 0) {
					fallbackToCurrent();
					return;
				}
				const idx = indexOfPath(items, abs);
				apply(items, idx >= 0 ? idx : 0);
			})
			.catch(() => fallbackToCurrent());

		return () => {
			cancelled = true;
		};
	}, [openId]);
}
