// 图片覆盖保存后的版本号：标注保存成功时 bump(path) 自增，预览窗 / 缩略图 / 附件 chip
// 按当前版本号拼 URL（`&v=`），绕开浏览器对同路径图片的缓存，看到刚保存的新图。
import { create } from "zustand";

interface ImageRevisionState {
	/** 绝对路径 → 版本号（无记录视为 0） */
	revisions: Record<string, number>;
	bumpImageRevision: (path: string) => void;
}

export const useImageRevisionStore = create<ImageRevisionState>((set) => ({
	revisions: {},
	bumpImageRevision: (path) =>
		set((s) => ({
			revisions: { ...s.revisions, [path]: (s.revisions[path] ?? 0) + 1 },
		})),
}));
