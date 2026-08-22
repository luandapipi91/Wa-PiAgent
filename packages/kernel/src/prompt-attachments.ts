import { relative } from "node:path";

/** element 附件定位信息（AttachmentRef element 变体的子集，解耦 shared 类型便于单测） */
export interface ElementRefLike {
	path: string;
	elLabel: string;
	startLine: number | null;
	endLine: number | null;
}

/**
 * element 附件序列化为定位文本：`rel/path [line: 33-35] [el: div.card]`。
 * 有 cwd 时转项目相对路径（与文件 @引用同口径）；无行号时省略 line 段。
 */
export function formatElementRef(a: ElementRefLike, cwd?: string): string {
	const rel = cwd ? relative(cwd, a.path).replace(/\\/g, "/") : a.path;
	const lines =
		a.startLine != null
			? ` [line: ${a.startLine}-${a.endLine ?? a.startLine}]`
			: "";
	return `${rel}${lines} [el: ${a.elLabel}]`;
}
