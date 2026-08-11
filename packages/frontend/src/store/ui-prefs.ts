import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { AppLanguage } from "../i18n/detect";
import { changeLanguage } from "../i18n";

/** 界面主题模式 */
export type ThemeMode = "system" | "light" | "dark";
/** 主题颜色 */
export type ThemeColor =
	| "green"
	| "blue"
	| "purple"
	| "yellow"
	| "orange"
	| "red";

/** 界面文字大小（px），12-32，默认 16。
 *  只缩放文字、不动布局：经 CSS 变量 --font-scale（= fontSize/16）实现，
 *  全项目字号声明（Tailwind 任意值 / 自定义规则 / rem 字号类覆盖）均以
 *  calc(... × var(--font-scale)) 挂到该变量，间距、尺寸、视口布局不变。 */
interface UiPrefsState {
	fontSize: number;
	setFontSize: (px: number) => void;
	/** 聊天导出为图片时取的对话轮数（1-5，默认 1）。 */
	exportTurns: number;
	setExportTurns: (n: number) => void;
	/** 图片导出范围：true=对话双方，false=仅导出 agent 回复（默认 true）。 */
	exportIncludeUser: boolean;
	setExportIncludeUser: (v: boolean) => void;
	/** 界面语言（默认 zh；首次启动由 i18n/detect 决定后写入）。 */
	language: AppLanguage;
	setLanguage: (lang: AppLanguage) => void;
	/** 任务完成提示音开关（默认 true），即时生效。 */
	soundTaskDone: boolean;
	setSoundTaskDone: (v: boolean) => void;
	/** 需要操作（ask_user_question 待回答）提示音开关（默认 true），即时生效。 */
	soundNeedsAction: boolean;
	setSoundNeedsAction: (v: boolean) => void;
	/** 开机自启开关（默认 true，安装后默认开启），通过 IPC 同步到系统注册表 */
	autoLaunch: boolean;
	setAutoLaunch: (v: boolean) => void;
	/** 界面主题模式（默认 system，跟随操作系统明暗） */
	themeMode: ThemeMode;
	setThemeMode: (mode: ThemeMode) => void;
	/** 主题颜色（默认 green） */
	themeColor: ThemeColor;
	setThemeColor: (color: ThemeColor) => void;
	/** 向导设置的默认智能体（displayName），null = 未设置 */
	defaultAgent: string | null;
	setDefaultAgent: (name: string | null) => void;
}

export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 32;
export const FONT_SIZE_DEFAULT = 16;

/** 导出图片对话轮数约束：1-5 轮，默认 1 轮（只导当条回复 + 其用户提问）。 */
export const EXPORT_TURNS_MIN = 1;
export const EXPORT_TURNS_MAX = 5;
export const EXPORT_TURNS_DEFAULT = 1;

/** 图片导出范围默认值：仅导出 agent 回复（不包含用户提问气泡）。 */
export const EXPORT_INCLUDE_USER_DEFAULT = false;

/** 默认语言。i18n/detect.ts 负责实际首次检测，store 初始值用 zh 兜底。 */
export const LANGUAGE_DEFAULT: AppLanguage = "zh";

export const SOUND_TASK_DONE_DEFAULT = true;
export const SOUND_NEEDS_ACTION_DEFAULT = true;

/** 开机自启默认值：安装后默认开启 */
export const AUTO_LAUNCH_DEFAULT = true;

export const THEME_MODE_DEFAULT: ThemeMode = "system";
export const THEME_COLOR_DEFAULT: ThemeColor = "green";

const STORAGE_KEY = "wa-pi-ui-prefs";

/** 解析 system 模式的实际明暗值 */
function resolveActualTheme(mode: ThemeMode): "light" | "dark" {
	if (mode !== "system") return mode;
	return window.matchMedia("(prefers-color-scheme: dark)").matches
		? "dark"
		: "light";
}

/** 应用明暗模式到 <html data-theme> */
function applyThemeMode(mode: ThemeMode) {
	try {
		document.documentElement.dataset.theme = resolveActualTheme(mode);
	} catch {
		/* 非浏览器环境静默降级 */
	}
}

/** 应用主题颜色到 <html data-accent> */
function applyThemeColor(color: ThemeColor) {
	try {
		document.documentElement.dataset.accent = color;
	} catch {
		/* 非浏览器环境静默降级 */
	}
}

/** 应用文字缩放系数到根节点 CSS 变量（16px = 1.0） */
function applyFontSize(px: number) {
	try {
		document.documentElement.style.setProperty(
			"--font-scale",
			String(px / FONT_SIZE_DEFAULT),
		);
	} catch {
		/* 非浏览器环境（测试 SSR 等）静默降级 */
	}
}

export const useUiPrefsStore = create<UiPrefsState>()(
	persist(
		(set) => ({
			fontSize: FONT_SIZE_DEFAULT,
			setFontSize: (px) => {
				const clamped = Math.min(
					FONT_SIZE_MAX,
					Math.max(FONT_SIZE_MIN, Math.round(px)),
				);
				applyFontSize(clamped);
				set({ fontSize: clamped });
			},
			exportTurns: EXPORT_TURNS_DEFAULT,
			setExportTurns: (n) => {
				const clamped = Math.min(
					EXPORT_TURNS_MAX,
					Math.max(EXPORT_TURNS_MIN, Math.round(n)),
				);
				set({ exportTurns: clamped });
			},
			exportIncludeUser: EXPORT_INCLUDE_USER_DEFAULT,
			setExportIncludeUser: (v) => set({ exportIncludeUser: v }),
			language: LANGUAGE_DEFAULT,
			setLanguage: (lang) => {
				set({ language: lang });
				// 同步 i18n 实例 + <html lang>；changeLanguage 内部幂等。
				void changeLanguage(lang);
			},
			soundTaskDone: SOUND_TASK_DONE_DEFAULT,
			setSoundTaskDone: (v) => set({ soundTaskDone: v }),
			soundNeedsAction: SOUND_NEEDS_ACTION_DEFAULT,
			setSoundNeedsAction: (v) => set({ soundNeedsAction: v }),
			autoLaunch: AUTO_LAUNCH_DEFAULT,
			setAutoLaunch: (v) => set({ autoLaunch: v }),
			themeMode: THEME_MODE_DEFAULT,
			setThemeMode: (mode) => {
				set({ themeMode: mode });
				applyThemeMode(mode);
			},
			themeColor: THEME_COLOR_DEFAULT,
			setThemeColor: (color) => {
				set({ themeColor: color });
				applyThemeColor(color);
			},
			defaultAgent: null,
			setDefaultAgent: (name) => set({ defaultAgent: name }),
		}),
		{
			name: STORAGE_KEY,
			// localStorage 恢复后立即应用，避免文字先小后大闪一下；
			// 语言同样在恢复后应用，保持 i18n 实例与持久化值一致。
			onRehydrateStorage: () => (state) => {
				if (!state) return;
				applyFontSize(state.fontSize);
				if (state.themeMode) applyThemeMode(state.themeMode);
				if (state.themeColor) applyThemeColor(state.themeColor);
				if (state.language) void changeLanguage(state.language);
			},
		},
	),
);

// 跟随系统：OS 明暗模式变化时，system 模式下自动重新 apply
if (typeof window !== "undefined" && window.matchMedia) {
	const mql = window.matchMedia("(prefers-color-scheme: dark)");
	mql.addEventListener("change", () => {
		if (useUiPrefsStore.getState().themeMode === "system") {
			applyThemeMode("system");
		}
	});
}
