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

/** 统一的「在系统文件管理器中打开」文案，随平台变化 */
export function openInFileManagerLabel(): string {
	switch (detectPlatform()) {
		case "mac":
			return "在访达中打开";
		case "windows":
			return "在资源管理器中打开";
		default:
			return "在文件管理器中打开";
	}
}
