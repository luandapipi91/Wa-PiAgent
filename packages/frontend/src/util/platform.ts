// 客户端操作系统检测：基于 navigator.userAgent，纯前端、同步。
// 本工具是本地应用（kernel 与用户同机），navigator 与后端 process.platform 实际一致。

export type Platform = "mac" | "windows" | "linux";

/** 当前操作系统（基于 navigator.userAgent 客户端检测） */
export function detectPlatform(): Platform {
	const ua = navigator.userAgent;
	if (/Mac|iPhone|iPad|iPod/.test(ua)) return "mac";
	if (/Win/.test(ua)) return "windows";
	return "linux";
}

/** 统一的「在系统文件管理器中打开」文案，随平台变化。
 *  接收可选的 labels 参数，调用方（组件）可传入 i18n 翻译值；不传则回退中文默认值，
 *  保持普通函数（如直接调用、单测）行为不变。 */
export function openInFileManagerLabel(labels?: {
	mac?: string;
	windows?: string;
	linux?: string;
}): string {
	const p = detectPlatform();
	if (p === "mac") return labels?.mac ?? "在访达中打开";
	if (p === "windows") return labels?.windows ?? "在资源管理器中打开";
	return labels?.linux ?? "在文件管理器中打开";
}
