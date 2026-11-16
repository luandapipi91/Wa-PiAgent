import { useEffect, useRef, useState } from "react";
import {
	applyThemeModePreview,
	isAccentApplicable,
	useUiPrefsStore,
	type ThemeMode,
} from "../../store/ui-prefs";
import { useTranslation } from "../../i18n/useTranslation";

interface Props {
	/** 点「使用此主题」时回调，参数为用户选中的主题 */
	onConfirm: (mode: ThemeMode) => void;
	/** 是否显示底部「使用此主题」按钮（升级引导显示，外观页/新手引导不显示） */
	showConfirm?: boolean;
	/** 选中即时回调（新手引导用它判断「是否已选、能否下一步」）；不传则仅内部预览 */
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

/** 每张卡片的预览样张配色（只用变量，自动跟随所选主题的观感差异靠色块布局体现） */
const PREVIEW_KEY: Record<ThemeMode, string> = {
	system: "settings.appearance.themeMode.system",
	light: "settings.appearance.themeMode.light",
	dark: "settings.appearance.themeMode.dark",
	newspaper: "settings.appearance.themeMode.newspaper",
	pixel: "settings.appearance.themeMode.pixel",
	cyber: "settings.appearance.themeMode.cyber",
};

/**
 * 主题选择卡片组：点卡片实时预览整页（只改 <html data-theme>，不落库），
 * 由调用方决定何时确认落库。关闭（卸载）时若未确认则回滚到进入前的主题。
 */
export function ThemePicker({ onConfirm, showConfirm = false, onSelect }: Props) {
	const { t } = useTranslation();
	// 进入前的主题快照：未确认就卸载时回滚，避免「点了几张卡又关掉」把页面留在预览态
	const restoreRef = useRef<string | null>(null);
	const confirmedRef = useRef(false);
	// 当前生效主题（只做标记，不算「用户已选」——新手引导要求主动选一次）
	const current = useUiPrefsStore((s) => s.themeMode);
	const [selected, setSelected] = useState<ThemeMode | null>(null);

	useEffect(() => {
		restoreRef.current = document.documentElement.dataset.theme ?? null;
		return () => {
			if (confirmedRef.current) return;
			const prev = restoreRef.current;
			if (prev) document.documentElement.dataset.theme = prev;
		};
	}, []);

	const pick = (mode: ThemeMode) => {
		setSelected(mode);
		applyThemeModePreview(mode);
		onSelect?.(mode);
	};

	const confirm = () => {
		if (!selected) return;
		confirmedRef.current = true;
		onConfirm(selected);
	};

	return (
		<div className="flex flex-col gap-3">
			<div className="grid grid-cols-2 gap-3 md:grid-cols-3">
				{THEME_CARDS.map((mode) => {
					const isSelected = selected === mode;
					return (
						<button
							key={mode}
							data-testid={`theme-card-${mode}`}
							data-selected={isSelected ? "true" : "false"}
							data-active={current === mode ? "true" : "false"}
							onClick={() => pick(mode)}
							aria-pressed={isSelected}
							className={`flex flex-col gap-2 rounded-md border p-2.5 text-left transition-colors ${
								isSelected
									? "border-accent bg-accent-soft"
									: "border-hairline bg-surface hover:bg-surface-hover"
							}`}
						>
							{/* 样张：三块色 + 一行文字，用当前主题变量绘制 */}
							<span className="flex h-9 items-center gap-1 rounded-sm border border-hairline bg-canvas px-1.5">
								<span className="h-4 w-4 rounded-sm bg-accent" />
								<span className="h-4 w-4 rounded-sm bg-surface" />
								<span className="h-4 w-4 rounded-sm bg-hairline-strong" />
								<span className="ml-auto text-[10px] text-primary">Aa</span>
							</span>
							<span className="flex items-center justify-between gap-1">
								<span className="text-xs font-medium text-primary">
									{t(PREVIEW_KEY[mode])}
								</span>
								{isSelected && (
									<span className="text-[10px] text-[var(--on-accent)]">✓</span>
								)}
							</span>
							{/* 固定配色主题标注「固定配色」，避免用户以为还能换强调色 */}
							{!isAccentApplicable(mode) && (
								<span className="text-[10px] text-tertiary">
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
						disabled={!selected}
						className="rounded-md bg-accent px-3 py-1.5 text-sm text-[var(--on-accent)] disabled:cursor-not-allowed disabled:opacity-50"
					>
						{t("themePicker.confirm")}
					</button>
				</div>
			)}
		</div>
	);
}
