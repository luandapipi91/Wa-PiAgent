import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { detectInitialLanguage, type AppLanguage } from "./detect";
import zh from "./locales/zh";
import en from "./locales/en";

/**
 * 同步 <html lang> 属性，便于辅助技术与搜索引擎识别界面语言。
 */
export function syncHtmlLang(lang: AppLanguage): void {
	try {
		document.documentElement.lang = lang;
	} catch {
		/* 非浏览器环境（测试 SSR 等）静默降级 */
	}
}

/** 切换语言并同步所有副作用（i18n 实例 + <html lang>）。供 store 调用。
 *  <html lang> 同步先行设置（不依赖 i18n.changeLanguage 的异步完成），避免
 *  连续切换时同步断言读到旧值。 */
export async function changeLanguage(lang: AppLanguage): Promise<void> {
	syncHtmlLang(lang);
	await i18n.changeLanguage(lang);
}

/** 首次启动语言（localStorage 优先 → navigator → zh）。模块加载时同步求值。 */
export const initialLanguage: AppLanguage = detectInitialLanguage();

/**
 * 模块加载即同步初始化 i18next 实例。
 *
 * 设计要点：
 * - 模块顶层自初始化（而非导出函数由 main.tsx 调用），这样任意通过 import 链
 *   触达本模块的代码（含测试、含 store 的 onRehydrateStorage）拿到的都是已 init
 *   的实例，避免「useTranslation 拿到未初始化实例」的时序问题。
 * - fallbackLng 为 "zh"（项目默认语言）；后端面向用户错误已改为结构化 KernelError code，
 *   前端按 kernelMsg 字典段渲染；此处保留中文兜底仅为向后兼容（新前端遇未命中 code 时
 *   回退 message 原串，旧前端/旧 kernel 不受影响）。
 * - escapeValue=false：React 自身转义文本节点，无需 i18next 重复转义。
 */
void i18n.use(initReactI18next).init({
	resources: {
		zh: { translation: zh },
		en: { translation: en },
	},
	lng: initialLanguage,
	fallbackLng: "zh",
	interpolation: { escapeValue: false },
	returnNull: false,
});
syncHtmlLang(initialLanguage);

export { detectInitialLanguage, type AppLanguage } from "./detect";
export { default } from "i18next";
