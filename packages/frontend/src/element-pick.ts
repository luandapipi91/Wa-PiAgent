import { api } from "./api-client";
import { formatElementToken } from "./quick-invoke/tokens";

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

/**
 * 元素选中发送到聊天：调 /api/preview-locate 取行号（失败降级无行号），
 * 组装元素 token 经 wa-pi:insert-mention 事件插入输入框（光标处内联 chip）。
 */
export async function sendElementToChat(
	path: string,
	picked: ElementPicked,
): Promise<void> {
	let startLine: number | null = null;
	let endLine: number | null = null;
	try {
		const r = (await api.get(
			`/api/preview-locate?path=${encodeURIComponent(path)}&selector=${encodeURIComponent(picked.selector)}`,
		)) as { startLine?: unknown; endLine?: unknown } | null;
		// 形状守护：两字段均 number|null 才采用，异常形状按无行号降级
		if (
			r &&
			(typeof r.startLine === "number" || r.startLine === null) &&
			(typeof r.endLine === "number" || r.endLine === null)
		) {
			startLine = r.startLine;
			endLine = r.endLine;
		}
	} catch {
		/* 行号是增强信息：接口失败降级为无行号 chip，不阻塞 */
	}
	const token = formatElementToken({
		path,
		startLine,
		endLine,
		elLabel: picked.elLabel,
	});
	// 前后补空格：防止与前/后文本粘连（粘连会污染定位路径、破坏 chip 化）
	window.dispatchEvent(
		new CustomEvent("wa-pi:insert-mention", { detail: { text: ` ${token} ` } }),
	);
}
