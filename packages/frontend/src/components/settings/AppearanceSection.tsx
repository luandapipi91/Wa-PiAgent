import { useTranslation } from "../../i18n/useTranslation";
import {
	FONT_SIZE_MAX,
	FONT_SIZE_MIN,
	useUiPrefsStore,
} from "../../store/ui-prefs";
import type { ThemeColor, ThemeMode } from "../../store/ui-prefs";

const THEME_MODES: ThemeMode[] = ["system", "light", "dark"];

/** 主题颜色 → 色值映射（用于圆点背景色） */
const COLOR_HEX: Record<ThemeColor, string> = {
	green: "#4ba26f",
	blue: "#3b82f6",
	purple: "#7c5cf6",
	yellow: "#c8941f",
	orange: "#ed7d2d",
	red: "#f0556b",
};

const THEME_COLORS: ThemeColor[] = [
	"green",
	"blue",
	"purple",
	"yellow",
	"orange",
	"red",
];

/** 内联 switch 滑块（样式与通用设置内的 SoundSwitch 一致：38×22 轨道 + 18×18 白点）。 */
function ToggleSwitch({
	on,
	onToggle,
	testId,
}: {
	on: boolean;
	onToggle: () => void;
	testId: string;
}) {
	return (
		<div
			role="switch"
			aria-checked={on}
			tabIndex={0}
			onClick={(e) => {
				e.stopPropagation();
				onToggle();
			}}
			onKeyDown={(e) => {
				if (e.key === " " || e.key === "Enter") {
					e.preventDefault();
					onToggle();
				}
			}}
			className="relative shrink-0 cursor-pointer"
			style={{
				width: 38,
				height: 22,
				borderRadius: 9999,
				background: on ? "var(--brand)" : "var(--hairline-strong)",
				transition: "background 0.2s",
			}}
			data-testid={testId}
			data-on={on ? "true" : "false"}
		>
			<span
				className="absolute top-0.5 rounded-full bg-white transition-all"
				style={{
					width: 18,
					height: 18,
					left: on ? undefined : 2,
					right: on ? 2 : undefined,
					boxShadow: "0 1px 2px rgba(0,0,0,.1)",
				}}
			/>
		</div>
	);
}

export function AppearanceSection() {
	const fontSize = useUiPrefsStore((s) => s.fontSize);
	const setFontSize = useUiPrefsStore((s) => s.setFontSize);
	const themeMode = useUiPrefsStore((s) => s.themeMode);
	const setThemeMode = useUiPrefsStore((s) => s.setThemeMode);
	const themeColor = useUiPrefsStore((s) => s.themeColor);
	const setThemeColor = useUiPrefsStore((s) => s.setThemeColor);
	const collapseProcessByDefault = useUiPrefsStore(
		(s) => s.collapseProcessByDefault,
	);
	const setCollapseProcessByDefault = useUiPrefsStore(
		(s) => s.setCollapseProcessByDefault,
	);
	const { t } = useTranslation();

	return (
		<div className="flex flex-col gap-4 p-4 overflow-auto">
			{/* 界面主题 */}
			<div className="flex flex-col gap-1">
				<span className="text-sm font-medium text-primary">
					{t("settings.appearance.themeMode.label")}
				</span>
				<span className="text-xs text-tertiary">
					{t("settings.appearance.themeMode.desc")}
				</span>
			</div>
			<div className="inline-flex w-fit bg-surface-hover rounded-md p-0.5">
				{THEME_MODES.map((mode) => (
					<button
						key={mode}
						onClick={() => setThemeMode(mode)}
						data-testid={`theme-mode-${mode}`}
						data-active={themeMode === mode ? "true" : "false"}
						className="px-4 py-1.5 rounded-sm text-sm transition-all"
						style={
							themeMode === mode
								? {
										background: "var(--surface)",
										color: "var(--text-primary)",
										fontWeight: 600,
										boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
									}
								: {
										color: "var(--text-secondary)",
									}
						}
					>
						{t(`settings.appearance.themeMode.${mode}`)}
					</button>
				))}
			</div>

			{/* 主题颜色 */}
			<div className="flex flex-col gap-1">
				<span className="text-sm font-medium text-primary">
					{t("settings.appearance.themeColor.label")}
				</span>
				<span className="text-xs text-tertiary">
					{t("settings.appearance.themeColor.desc")}
				</span>
			</div>
			<div className="flex items-center gap-3.5">
				{THEME_COLORS.map((color) => (
					<button
						key={color}
						onClick={() => setThemeColor(color)}
						data-testid={`theme-color-${color}`}
						data-active={themeColor === color ? "true" : "false"}
						className="relative cursor-pointer shrink-0 transition-transform hover:scale-110"
						style={{
							width: 32,
							height: 32,
							borderRadius: "50%",
							background: COLOR_HEX[color],
							boxShadow:
								themeColor === color
									? `0 0 0 3px var(--surface), 0 0 0 5px ${COLOR_HEX[color]}`
									: "none",
						}}
						aria-label={color}
					>
						{themeColor === color && (
							<span
								style={{
									position: "absolute",
									inset: 0,
									display: "flex",
									alignItems: "center",
									justifyContent: "center",
									color: "#fff",
									fontSize: 14,
									fontWeight: 700,
								}}
							>
								✓
							</span>
						)}
					</button>
				))}
			</div>

			{/* 文字大小（即时生效） */}
			<div className="flex flex-col gap-1">
				<span className="text-sm font-medium text-primary">
					{t("settings.appearance.fontSize.label")}
				</span>
				<span className="text-xs text-tertiary">
					{t("settings.appearance.fontSize.desc", {
						min: FONT_SIZE_MIN,
						max: FONT_SIZE_MAX,
					})}
				</span>
			</div>
			<div className="flex items-center gap-3 w-72">
				<input
					type="range"
					min={FONT_SIZE_MIN}
					max={FONT_SIZE_MAX}
					step={1}
					value={fontSize}
					onChange={(e) => setFontSize(Number(e.target.value))}
					className="flex-1 cursor-pointer"
					aria-label={t("settings.appearance.fontSize.label")}
					data-testid="font-size-slider"
				/>
				<span
					className="text-sm text-primary w-12 text-right"
					data-testid="font-size-value"
				>
					{fontSize}px
				</span>
			</div>

			{/* 回复过程默认折叠（即时生效） */}
			<div className="flex items-center justify-between gap-4">
				<div className="flex flex-col gap-1">
					<span className="text-sm font-medium text-primary">
						{t("settings.appearance.collapseProcess.label")}
					</span>
					<span className="text-xs text-tertiary">
						{t("settings.appearance.collapseProcess.desc")}
					</span>
				</div>
				<ToggleSwitch
					on={collapseProcessByDefault}
					onToggle={() => setCollapseProcessByDefault(!collapseProcessByDefault)}
					testId="collapse-process-toggle"
				/>
			</div>
		</div>
	);
}
