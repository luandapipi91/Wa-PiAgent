/** 应用支持的语言。本轮中/英双语。 */
export type AppLanguage = "zh" | "en";

/**
 * 语言偏好在 localStorage 的持久化 key。
 * 与 store/ui-prefs.ts 的 STORAGE_KEY 保持一致——zustand persist 把
 * { state: { fontSize, exportTurns, language }, version } 整体存到这个 key 下，
 * 这里只读取其中的 language 字段。
 */
const UI_PREFS_STORAGE_KEY = "wa-pi-ui-prefs";

/** 从 zustand persist 的存储格式中解析出已持久化的语言偏好。 */
function readPersistedLanguage(raw: string | null): AppLanguage | null {
	if (!raw) return null;
	try {
		const lang = JSON.parse(raw)?.state?.language;
		if (lang === "zh" || lang === "en") return lang;
	} catch {
		/* localStorage 损坏，忽略，回退到环境检测 */
	}
	return null;
}

/**
 * 决定首次启动时的界面语言（纯函数，可单测）。
 *
 * 优先级：
 * 1. `WA_PI_LANG` 环境变量（仅测试环境使用：bun test --isolate 下各文件模块图
 *    独立、globalThis 不共享，而 process.env 进程级共享，故用它锁定语言避免
 *    组件测试文案漂移；生产永不设置）
 * 2. localStorage 已持久化的用户选择（用户显式选择过则尊重）
 * 3. navigator.language —— `zh*` → 中文，其余 → 英文
 * 4. 无法访问 navigator（SSR / 无浏览器环境）→ 中文（项目默认语言）
 *
 * 该函数在 React 首次渲染前调用，避免英文环境用户首屏闪一下中文。
 */
export function detectInitialLanguage(): AppLanguage {
	// 0. 测试钩子：环境变量优先级最高，锁定语言
	const env = (typeof process !== "undefined" && process.env?.WA_PI_LANG) || "";
	if (env === "zh" || env === "en") return env;

	// 1. 已持久化的用户选择优先
	try {
		const stored = readPersistedLanguage(
			localStorage.getItem(UI_PREFS_STORAGE_KEY),
		);
		if (stored) return stored;
	} catch {
		/* 无 localStorage 访问权限（隐私模式等） */
	}

	// 2. 浏览器语言环境
	try {
		const navLang =
			(navigator as { language?: unknown }).language ?? "";
		if (
			typeof navLang === "string" &&
			navLang.toLowerCase().startsWith("zh")
		) {
			return "zh";
		}
		if (typeof navLang === "string" && navLang.length > 0) {
			return "en";
		}
	} catch {
		/* 无 navigator（SSR 等） */
	}

	// 3. 回退默认语言
	return "zh";
}
