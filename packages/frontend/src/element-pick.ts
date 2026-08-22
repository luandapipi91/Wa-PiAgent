import type { AttachmentDraft } from "@wa-pi/shared";
import { api } from "./api-client";
import { useComposerPrefsStore } from "./store/composer-prefs";

/** inspect 脚本 postMessage 回传的元素信息 */
export interface ElementPicked {
	selector: string;
	tagName: string;
	elLabel: string;
}

/** 校验并解析 inspect 消息；格式不符一律 null（不信任 message content） */
export function parseInspectMessage(data: unknown): ElementPicked | null {
	if (!data || typeof data !== "object") return null;
	const d = data as Record<string, unknown>;
	if (d.type !== "hiagent:element-picked") return null;
	if (
		typeof d.selector !== "string" ||
		typeof d.tagName !== "string" ||
		typeof d.elLabel !== "string"
	) {
		return null;
	}
	return { selector: d.selector, tagName: d.tagName, elLabel: d.elLabel };
}

/** 组装 element 附件草稿；name 为 chip 展示文案：文件名[:起始行] <标签> */
export function buildElementDraft(
	path: string,
	picked: ElementPicked,
	loc: { startLine: number | null; endLine: number | null },
): AttachmentDraft {
	const base = path.split(/[\\/]/).pop() ?? path;
	const name =
		loc.startLine != null
			? `${base}:${loc.startLine} <${picked.elLabel}>`
			: `${base} <${picked.elLabel}>`;
	return {
		kind: "element",
		name,
		path,
		selector: picked.selector,
		elLabel: picked.elLabel,
		startLine: loc.startLine,
		endLine: loc.endLine,
	};
}

/**
 * 元素选中落 chip：调 /api/preview-locate 取行号（失败降级无行号），
 * 追加到该会话 composer 附件列表。无会话返回 "no-session" 由调用方提示。
 */
export async function handleElementPicked(
	path: string,
	picked: ElementPicked,
	sessionId: string | null,
): Promise<"ok" | "no-session"> {
	if (!sessionId) return "no-session";
	let loc = { startLine: null as number | null, endLine: null as number | null };
	try {
		const res = (await api.get(
			`/api/preview-locate?path=${encodeURIComponent(path)}&selector=${encodeURIComponent(picked.selector)}`,
		)) as { startLine?: unknown; endLine?: unknown } | null;
		// 形状守护：startLine/endLine 均为 number|null 才采用，异常形状按无行号降级
		if (
			res &&
			(typeof res.startLine === "number" || res.startLine === null) &&
			(typeof res.endLine === "number" || res.endLine === null)
		) {
			loc = { startLine: res.startLine, endLine: res.endLine };
		}
	} catch {
		/* 行号是增强信息：接口失败降级为无行号 chip，不阻塞 */
	}
	const draft = buildElementDraft(path, picked, loc);
	const prefs = useComposerPrefsStore.getState();
	const cur = prefs.bySession[sessionId]?.attachments ?? [];
	prefs.setSessionPrefs(sessionId, { attachments: [...cur, draft] });
	return "ok";
}
