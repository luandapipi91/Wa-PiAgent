import { create } from "zustand";
import { persist } from "zustand/middleware";

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
}

export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 32;
export const FONT_SIZE_DEFAULT = 16;

/** 导出图片对话轮数约束：1-5 轮，默认 1 轮（只导当条回复 + 其用户提问）。 */
export const EXPORT_TURNS_MIN = 1;
export const EXPORT_TURNS_MAX = 5;
export const EXPORT_TURNS_DEFAULT = 1;

const STORAGE_KEY = "wa-pi-ui-prefs";

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
		}),
		{
			name: STORAGE_KEY,
			// localStorage 恢复后立即应用，避免文字先小后大闪一下
			onRehydrateStorage: () => (state) => {
				if (state) applyFontSize(state.fontSize);
			},
		},
	),
);
