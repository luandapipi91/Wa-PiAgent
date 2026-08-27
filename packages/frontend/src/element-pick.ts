import { api } from "./api-client";
import { formatElementToken } from "./quick-invoke/tokens";

/** inspect 脚本 postMessage 回传的元素信息 */
export interface ElementPicked {
	selector: string;
	tagName: string;
	elLabel: string;
	/** 嵌套 iframe 场景：选中元素实际所在页面的磁盘路径（单层预览时由脚本填入同一值，可为空——旧消息兼容） */
	srcPath?: string;
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
	// srcPath 可选；null（srcdoc 解析不出磁盘路径的合法信号）与 undefined 同等视为缺省；
	// 两者之外出现非字符串才是形状非法。此前把 null 也拒之门外，导致 srcdoc 内选中后
	// 点「发送到聊天」整条消息被丢弃、聊天框无反应。
	if (
		d.srcPath !== undefined &&
		d.srcPath !== null &&
		typeof d.srcPath !== "string"
	) {
		return null;
	}
	const picked: ElementPicked = {
		selector: d.selector,
		tagName: d.tagName,
		elLabel: d.elLabel,
	};
	if (typeof d.srcPath === "string") picked.srcPath = d.srcPath;
	return picked;
}

/**
 * 元素选中发送到聊天：调 /api/preview-locate 取行号（失败降级无行号），
 * 组装元素 token 经 wa-pi:insert-mention 事件插入输入框（光标处内联 chip）。
 */
export async function sendElementToChat(
	path: string,
	picked: ElementPicked,
): Promise<void> {
	// 嵌套 iframe：选中元素在实际加载的子页面里，优先用 picked.srcPath 定位；
	// 无 srcPath（旧版脚本/单层）回退外层 path，行为不变
	const locatePath = picked.srcPath || path;
	let startLine: number | null = null;
	let endLine: number | null = null;
	try {
		const r = (await api.get(
			`/api/preview-locate?path=${encodeURIComponent(locatePath)}&selector=${encodeURIComponent(picked.selector)}`,
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
		path: locatePath,
		startLine,
		endLine,
		elLabel: picked.elLabel,
	});
	// 前后补空格：防止与前/后文本粘连（粘连会污染定位路径、破坏 chip 化）
	window.dispatchEvent(
		new CustomEvent("wa-pi:insert-mention", { detail: { text: ` ${token} ` } }),
	);
}
