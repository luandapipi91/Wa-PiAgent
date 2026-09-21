// 同目录画廊工具：把「当前预览文件所在目录」的目录项整理成画廊媒体清单。
// 画廊 items 原先来自消息文本扫描（会话内集合），本模块支撑「改成同目录」的路径推导、
// 工作区判断、目录项过滤排序与当前项定位。
import { mediaKindOf } from "./file-path";
import type { MediaItem } from "./media-utils";

/** 归一化：反斜杠 → 正斜杠、合并连续斜杠、去尾斜杠（保留根 "/"） */
function normalize(p: string): string {
	const s = p.replace(/\\/g, "/").replace(/\/+/g, "/");
	return s.length > 1 ? s.replace(/\/+$/, "") : s;
}

/** 所在目录；无分隔符时返回空串（调用方按「无法确定目录」处理） */
export function dirOf(absPath: string): string {
	const s = normalize(absPath);
	const i = s.lastIndexOf("/");
	if (i < 0) return "";
	return i === 0 ? "/" : s.slice(0, i);
}

/** 目录 + 文件名拼接（目录反斜杠/尾斜杠都兼容） */
export function joinPath(dir: string, name: string): string {
	const base = normalize(dir).replace(/\/+$/, "");
	return `${base}/${name}`;
}

/**
 * 路径是否落在任一项目工作区内。与内核 /file 白名单同口径的粗判（前缀匹配，
 * 大小写不敏感以兼容 Windows）：工作区外的同目录文件列出来也渲染不了，
 * 故在列目录前就回退。
 */
export function isInAnyCwd(path: string, cwds: string[]): boolean {
	const p = normalize(path).toLowerCase();
	return cwds.some((cwd) => {
		const c = normalize(cwd).toLowerCase();
		if (!c) return false;
		return p === c || p.startsWith(c.endsWith("/") ? c : `${c}/`);
	});
}

/** 目录项 → 画廊媒体清单：排除目录与非媒体文件，按文件名自然序（img2 在 img10 前） */
export function mediaItemsFromEntries(
	dir: string,
	entries: { name: string; isDir: boolean }[],
): MediaItem[] {
	return entries
		.filter((e) => !e.isDir)
		.map((e) => ({ name: e.name, kind: mediaKindOf(e.name) }))
		.filter(
			(e): e is { name: string; kind: "image" | "video" } => e.kind !== null,
		)
		.sort((a, b) =>
			a.name.localeCompare(b.name, undefined, {
				sensitivity: "base",
				numeric: true,
			}),
		)
		.map((e) => ({ src: joinPath(dir, e.name), kind: e.kind, name: e.name }));
}

/** 在清单中定位某绝对路径的下标（反斜杠/大小写归一），找不到返回 -1 */
export function indexOfPath(items: MediaItem[], absPath: string): number {
	const target = normalize(absPath).toLowerCase();
	return items.findIndex((it) => normalize(it.src).toLowerCase() === target);
}

/** 两个清单是否逐项等价（避免把等价结果写回 store 触发无谓渲染） */
export function sameItems(a: MediaItem[], b: MediaItem[]): boolean {
	return (
		a.length === b.length &&
		a.every(
			(x, i) =>
				x.src === b[i].src && x.kind === b[i].kind && x.name === b[i].name,
		)
	);
}
