import { useState } from "react";
import {
	isAccentApplicable,
	useUiPrefsStore,
	type ThemeMode,
} from "../../store/ui-prefs";
import { useTranslation } from "../../i18n/useTranslation";

interface Props {
	/** 点「完成」时回调，参数为用户选中的主题（主题在点卡片时就已生效并落库） */
	onConfirm: (mode: ThemeMode) => void;
	/** 是否显示底部「完成」按钮（升级引导显示，新手引导用「下一步」代替） */
	showConfirm?: boolean;
	/** 选中即时回调（新手引导用它判断「是否已选、能否下一步」） */
	onSelect?: (mode: ThemeMode) => void;
}

/** 卡片顺序：跟随系统排最前，其后浅/深色，最后三套风格化主题 */
const THEME_CARDS: ThemeMode[] = [
	"system",
	"light",
	"dark",
	"newspaper",
	"pixel",
	"cyber",
];

/**
 * 每张卡片的缩略样张：用该主题自己的固定色值绘制（不用 CSS 变量——变量会全部跟着
 * 当前主题变，六张卡就会长得一模一样，失去「先看看长啥样」的意义）。
 * 取值与本项目 styles.css 里对应主题块保持一致。
 */
const PREVIEW_STYLE: Record<
	ThemeMode,
	{ bg: string; surface: string; accent: string; text: string; radius: string; border: string }
> = {
	system: {
		bg: "#f5f5f7",
		surface: "#ffffff",
		accent: "#4ba26f",
		text: "#1d1d1f",
		radius: "8px",
		border: "#e5e5ea",
	},
	light: {
		bg: "#f5f5f7",
		surface: "#ffffff",
		accent: "#4ba26f",
		text: "#1d1d1f",
		radius: "8px",
		border: "#e5e5ea",
	},
	dark: {
		bg: "#1a1a1e",
		surface: "#2c2c2e",
		accent: "#5cb87f",
		text: "#f5f5f7",
		radius: "8px",
		border: "#38383a",
	},
	newspaper: {
		bg: "#f4ecd8",
		surface: "#faf5e6",
		accent: "#a32f27",
		text: "#1a150f",
		radius: "0px",
		border: "#c9bea5",
	},
	pixel: {
		bg: "#1a1526",
		surface: "#241e38",
		accent: "#ffd34e",
		text: "#f2ede3",
		radius: "0px",
		border: "#4a3e6b",
	},
	cyber: {
		bg: "#05070a",
		surface: "#0c141c",
		accent: "#00f0ff",
		text: "#d7f7ff",
		radius: "2px",
		border: "rgba(0,240,255,0.42)",
	},
};

/** 卡片标签文案的 i18n key */
const PREVIEW_KEY: Record<ThemeMode, string> = {
	system: "settings.appearance.themeMode.system",
	light: "settings.appearance.themeMode.light",
	dark: "settings.appearance.themeMode.dark",
	newspaper: "settings.appearance.themeMode.newspaper",
	pixel: "settings.appearance.themeMode.pixel",
	cyber: "settings.appearance.themeMode.cyber",
};

/**
 * 主题选择卡片组：点卡片即切换并落库（与外观页 select 一致的「即时生效」语义），
 * 刷新/关闭弹窗都不会丢选择。不提供预览态——预览会让用户以为选了却没保存。
 */
export function ThemePicker({ onConfirm, showConfirm = false, onSelect }: Props) {
	const { t } = useTranslation();
	const current = useUiPrefsStore((s) => s.themeMode);
	const [selected, setSelected] = useState<ThemeMode | null>(null);

	const pick = (mode: ThemeMode) => {
		setSelected(mode);
		// 即时落库：点一下就生效，刷新/关闭都不丢
		useUiPrefsStore.getState().setThemeMode(mode);
		onSelect?.(mode);
	};

	const confirm = () => {
		onConfirm(selected ?? current);
	};

	return (
		<div className="flex flex-col gap-3">
			<div className="grid grid-cols-2 gap-3 md:grid-cols-3">
				{THEME_CARDS.map((mode) => {
					const isSelected = selected === mode;
					const st = PREVIEW_STYLE[mode];
					return (
						<button
							key={mode}
							data-testid={`theme-card-${mode}`}
							data-selected={isSelected ? "true" : "false"}
							data-active={current === mode ? "true" : "false"}
							onClick={() => pick(mode)}
							aria-pressed={isSelected}
							className={`flex flex-col gap-2 border-2 p-2.5 text-left transition-all ${
								isSelected ? "border-accent" : "border-transparent"
							}`}
							style={{
								// 整张卡就是该主题的一张样张：底色/文字/圆角全部取该主题自己的值，
								// 这样六张卡在任何当前主题下都保持各自真面目
								background: st.bg,
								color: st.text,
								borderRadius: st.radius,
								boxShadow: isSelected ? `0 0 0 1px ${st.accent}` : undefined,
							}}
						>
							{/* 缩略样张：用该主题自己的色值画，才能一眼看出差异 */}
							<span
								className="flex h-10 items-center gap-1 border px-1.5"
								style={{
									background: st.bg,
									borderColor: st.border,
									borderRadius: st.radius,
								}}
							>
								<span
									style={{
										width: 14,
										height: 14,
										background: st.accent,
										borderRadius: st.radius,
									}}
								/>
								<span
									style={{
										width: 14,
										height: 14,
										background: st.surface,
										border: `1px solid ${st.border}`,
										borderRadius: st.radius,
									}}
								/>
								<span
									className="ml-auto text-[11px]"
									style={{ color: st.text }}
								>
									Aa
								</span>
							</span>
							{/* 卡片本体背景跟随「当前生效主题」，故标签也用当前主题的文字色
							    （text-primary）才能始终与底色成对；样张内部才用各主题自己的色 */}
							<span className="flex items-center justify-between gap-1">
								<span className="text-xs font-medium">
									{t(PREVIEW_KEY[mode])}
								</span>
								{isSelected && (
									<span className="text-[10px]" style={{ color: st.accent }}>✓</span>
								)}
							</span>
							{/* 固定配色主题标注，避免用户以为还能换强调色 */}
							{!isAccentApplicable(mode) && (
								<span className="text-[10px] opacity-65">
									{t("themePicker.fixedPalette")}
								</span>
							)}
						</button>
					);
				})}
			</div>
			{showConfirm && (
				<div className="flex justify-end">
					<button
						data-testid="theme-confirm"
						onClick={confirm}
						className="rounded-md bg-accent px-3 py-1.5 text-sm text-[var(--on-accent)]"
					>
						{t("themePicker.confirm")}
					</button>
				</div>
			)}
		</div>
	);
}
