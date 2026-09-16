// 对话媒体预览公共工具：媒体 src 路径映射、视频段落检测、画廊媒体清单收集。
// ⚠️ 循环依赖约束（同 markdown-components 头部注释）：本模块 import FilePill 的
// resolveAbsolutePath 只在函数体内调用（渲染期/事件期），顶层不得求值 FilePill 模块级值。
import { defaultUrlTransform } from "react-markdown";
import { resolveAbsolutePath } from "./FilePill";
import { mediaKindOf } from "./file-path";
import { pathToUploadUrl } from "../../fs-client";

export type MediaItem = { src: string; kind: "image" | "video"; name: string };

/** 从路径/URL 提取文件名（去 query/hash，兼容正反斜杠） */
export function fileNameOf(src: string): string {
	const noQuery = src.split(/[?#]/)[0];
	return noQuery.replace(/\\/g, "/").split("/").pop() ?? src;
}

/** 媒体 src 路径映射：http(s)/data/blob 原样；本地绝对/相对路径 → kernel /file URL */
export function resolveMediaSrc(src: string, sessionId: string): string {
	if (/^(https?:|data:|blob:)/i.test(src)) return src;
	return pathToUploadUrl(resolveAbsolutePath(src, sessionId));
}

/** md 预览相对路径解析（baseDir 拼接）：FileViewer 的 PreviewImage 与 a 渲染器共用 */
export function joinBaseDir(baseDir: string, rel: string): string {
	return `${baseDir.replace(/\\/g, "/").replace(/\/$/, "")}/${rel}`;
}

// 视频段落：整段（trim 后）完全匹配「裸路径/URL」或「markdown 链接 [name](path)」，
// 扩展名 mp4/webm/mov/mkv/avi/m4v（可带 query）。^$ 锚定整段——句中夹杂路径不匹配。
const VIDEO_PARAGRAPH_RE =
	/^(?:\[([^\]]*)\]\((\S+?\.(?:mp4|webm|mov|mkv|avi|m4v)(?:\?\S*)?)\)|(\S+?\.(?:mp4|webm|mov|mkv|avi|m4v)(?:\?\S*)?))$/i;

/** 整段完全匹配视频路径/URL → { src, name }；否则 null */
export function matchVideoParagraph(
	text: string,
): { src: string; name: string } | null {
	const m = VIDEO_PARAGRAPH_RE.exec(text.trim());
	if (!m) return null;
	const src = m[2] ?? m[3];
	return { src, name: m[1]?.trim() || fileNameOf(src) };
}

export type TextPart =
	| { kind: "markdown"; text: string }
	| { kind: "video"; src: string; name: string }
	| { kind: "image"; src: string; name: string };

// 围栏代码块整块只有一个媒体路径：模型常把产出路径放在 ```text 块里。
// 整块匹配才放行——围栏里混有其他内容仍按代码块渲染（防误伤真代码）。
const FENCED_MEDIA_RE = /^```[^\n]*\n?([\s\S]*?)\n?```$/;

/** 整块围栏内容恰为单个媒体路径 → { src, kind, name }；否则 null */
export function matchFencedMedia(
	text: string,
): { src: string; kind: "image" | "video"; name: string } | null {
	const m = FENCED_MEDIA_RE.exec(text.trim());
	if (!m) return null;
	const inner = m[1].trim();
	if (!/^\S+$/.test(inner)) return null;
	const kind = mediaKindOf(inner);
	if (!kind) return null;
	return { src: inner, kind, name: fileNameOf(inner) };
}

/**
 * 把文本块按空行分段，整段命中视频的抽为 video part，其余合并回 markdown。
 * 围栏代码块（```）内的空行不分段（代码块可含空行，切开会破坏高亮与结构）。
 */
export function splitMediaParagraphs(text: string): TextPart[] {
	const paras: string[] = [];
	let cur: string[] = [];
	let inFence = false;
	for (const line of text.split("\n")) {
		if (/^\s*```/.test(line)) inFence = !inFence;
		if (!inFence && line.trim() === "") {
			if (cur.length) {
				paras.push(cur.join("\n"));
				cur = [];
			}
		} else {
			cur.push(line);
		}
	}
	if (cur.length) paras.push(cur.join("\n"));

	const parts: TextPart[] = [];
	let md: string[] = [];
	const flush = () => {
		if (md.length) {
			parts.push({ kind: "markdown", text: md.join("\n\n") });
			md = [];
		}
	};
	for (const p of paras) {
		const v = matchVideoParagraph(p);
		if (v) {
			flush();
			parts.push({ kind: "video", src: v.src, name: v.name });
		} else if (p.includes("```")) {
			// 含围栏代码块的段落独立成 part，不与前后普通段落合并（避免破坏代码块结构）；
			// 整块围栏恰为单个媒体路径时抽为媒体 part（模型常把产出路径放 ```text 块里）
			const fenced = matchFencedMedia(p);
			flush();
			if (fenced) {
				parts.push({ kind: fenced.kind, src: fenced.src, name: fenced.name });
			} else {
				parts.push({ kind: "markdown", text: p });
			}
		} else {
			md.push(p);
		}
	}
	flush();
	return parts;
}

// 文本内联媒体：![]() 图片语法，或反引号包裹的媒体路径（FilePill 同款——模型常用
// 表格 + 行内代码列路径，如 `out/logo.png`，可选 :行号 后缀在收集时去掉）。
const INLINE_MEDIA_RE =
	/!\[([^\]]*)\]\((\S+?)\)|`([^`]+?\.(?:png|jpe?g|gif|webp|svg|bmp|ico|avif|mp4|webm|mov|mkv|avi|m4v))(?::\d+)*`/gi;

/** 收集文本块内全部媒体（图片 ![]() + 视频段落 + 反引号媒体路径），按文档顺序，供画廊 items。
 *  围栏代码块内容先剔除——代码块里的 ![](x) 是代码文本不是图片。
 *  同一文件以多种形式重复出现（如 ![]() 与反引号路径并列）时按 src+kind 去重，保留首次出现。
 *  src 统一归一为正斜杠：模型在 Windows 上常写反斜杠路径，画廊定位比较（it.src === src）
 *  与 parseFilePath 的正斜杠口径才能对上。 */
export function collectMediaItems(text: string): MediaItem[] {
	const items: MediaItem[] = [];
	const push = (item: MediaItem) => {
		const src = item.src.replace(/\\/g, "/");
		if (!items.some((it) => it.src === src && it.kind === item.kind)) {
			items.push({ ...item, src });
		}
	};
	for (const part of splitMediaParagraphs(text)) {
		if (part.kind === "video" || part.kind === "image") {
			push({ src: part.src, kind: part.kind, name: part.name });
			continue;
		}
		const noCode = part.text.replace(/```[\s\S]*?(?:```|$)/g, "");
		const re = new RegExp(INLINE_MEDIA_RE);
		let m: RegExpExecArray | null;
		while ((m = re.exec(noCode))) {
			if (m[2] !== undefined) {
				push({
					src: m[2],
					kind: "image",
					name: m[1].trim() || fileNameOf(m[2]),
				});
			} else {
				const kind = mediaKindOf(m[3]);
				if (kind) push({ src: m[3], kind, name: fileNameOf(m[3]) });
			}
		}
	}
	return items;
}

/** 复制路径用：http(s)/data/blob 原样；本地路径解析为绝对路径（与 FilePill 同一 cwd 口径） */
export function resolveCopyPath(src: string, sessionId: string): string {
	if (/^(https?:|data:|blob:)/i.test(src)) return src;
	return resolveAbsolutePath(src, sessionId);
}

/** react-markdown 的 urlTransform：默认实现把 Windows 盘符路径（C:/...）误判为未知协议
 *  清洗为空串，导致 ![](C:/abs/x.png) 的 img src 为空、缩略图完全不渲染。
 *  盘符路径直接放行，其余仍走默认消毒（javascript: 等注入协议继续拦截）。 */
export function mediaUrlTransform(url: string): string {
	if (/^[a-zA-Z]:[\\/]/.test(url)) return url;
	return defaultUrlTransform(url);
}
