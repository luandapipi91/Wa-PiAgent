import { useEffect, useState } from "react";
import { useTranslation } from "../../i18n/useTranslation";
import { api } from "../../api-client";
import type { RetrySettings } from "@wa-pi/shared";
import {
	EXPORT_TURNS_MAX,
	EXPORT_TURNS_MIN,
	FONT_SIZE_MAX,
	FONT_SIZE_MIN,
	useUiPrefsStore,
} from "../../store/ui-prefs";
import { useToastStore } from "../../store/toast";
import { previewNeedsAction, previewTaskDone } from "../../util/sound";
import type { AppLanguage } from "../../i18n/detect";

/** 与 kernel settings-store 的产品约束对齐（重试最多 10 次；间隔 0.5s-60s） */
const MAX_RETRIES = 10;
const MIN_DELAY_S = 0.5;
const MAX_DELAY_S = 60;

/**
 * 内联 switch 滑块（与设置弹窗内插件/命令开关风格一致：38×22 轨道 + 18×18 白点）。
 * 提示音开关即时生效，不走保存草稿流。
 */
function SoundSwitch({
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
				background: on ? "var(--success)" : "#cbd5e1",
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

/**
 * 通用设置：pi 自动重试配置（transient 错误——网络/超时/5xx/限流——后的自动重试）。
 * 保存到 settings.json.retry，pi 进程启动时加载；kernel 保存后会标脏活跃会话，
 * 下次发消息时重建进程生效。
 *
 * 语言切换为草稿态：select 只改本地 draft，点「保存」才调 setLanguage 生效；
 * 关闭窗口不保存则还原（组件卸载，store 仍为原值）。
 */
export function GeneralSection() {
	const [maxRetries, setMaxRetries] = useState("3");
	const [delaySeconds, setDelaySeconds] = useState("2");
	const [httpTimeoutSeconds, setHttpTimeoutSeconds] = useState("120");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	const fontSize = useUiPrefsStore((s) => s.fontSize);
	const setFontSize = useUiPrefsStore((s) => s.setFontSize);
	const exportTurns = useUiPrefsStore((s) => s.exportTurns);
	const setExportTurns = useUiPrefsStore((s) => s.setExportTurns);
	const language = useUiPrefsStore((s) => s.language);
	const setLanguage = useUiPrefsStore((s) => s.setLanguage);
	const soundTaskDone = useUiPrefsStore((s) => s.soundTaskDone);
	const setSoundTaskDone = useUiPrefsStore((s) => s.setSoundTaskDone);
	const soundNeedsAction = useUiPrefsStore((s) => s.soundNeedsAction);
	const setSoundNeedsAction = useUiPrefsStore((s) => s.setSoundNeedsAction);
	const { t } = useTranslation();
	// 语言草稿：select 改草稿，点保存才 setLanguage 生效；关闭窗口丢弃草稿。
	const [draftLang, setDraftLang] = useState<AppLanguage>(language);
	// 字号 / 导出轮数草稿：滑块只改草稿，点保存才 setFontSize/setExportTurns 生效，
	// 与语言/重试配置一致（保存后才生效）。关闭窗口不保存则还原（store 仍为原值）。
	const [draftFontSize, setDraftFontSize] = useState(fontSize);
	const [draftExportTurns, setDraftExportTurns] = useState(exportTurns);

	useEffect(() => {
		api
			.get("/api/settings/retry")
			.then((res) => {
				const retry = (res as any)?.retry as RetrySettings | undefined;
				if (retry) {
					setMaxRetries(String(retry.maxRetries));
					setDelaySeconds(String(retry.baseDelayMs / 1000));
				}
				const httpIdleMs = (res as any)?.httpIdleTimeoutMs as
					| number
					| undefined;
				if (typeof httpIdleMs === "number") {
					setHttpTimeoutSeconds(String(Math.round(httpIdleMs / 1000)));
				}
			})
			.catch((e) => setError(e instanceof Error ? e.message : String(e)))
			.finally(() => setLoading(false));
	}, []);

	const handleSave = async () => {
		const retries = Number(maxRetries);
		const delayMs = Math.round(Number(delaySeconds) * 1000);
		const httpIdleMs = Math.round(Number(httpTimeoutSeconds) * 1000);
		setSaving(true);
		setSaved(false);
		try {
			await api.put("/api/settings/retry", {
				retry: { maxRetries: retries, baseDelayMs: delayMs },
				httpIdleTimeoutMs: httpIdleMs,
			});
			// 字号 / 导出轮数草稿生效（仅当与当前值不同时才写入）
			if (draftFontSize !== fontSize) setFontSize(draftFontSize);
			if (draftExportTurns !== exportTurns) setExportTurns(draftExportTurns);
			// 语言草稿生效（仅当与当前值不同时才写入）
			if (draftLang !== language) setLanguage(draftLang);
			setSaved(true);
		} catch (e) {
			// 保存失败：用 toast 提示，不再在按钮旁显示 inline 文本
			// （加载配置失败的 error state 仍保留 inline，由 useEffect 设置）
			useToastStore
				.getState()
				.add(e instanceof Error ? e.message : String(e), "error");
		} finally {
			setSaving(false);
		}
	};

	if (loading) {
		return (
			<div className="p-4 text-sm text-tertiary">{t("common.loading")}</div>
		);
	}

	return (
		<div className="flex flex-col gap-4 p-4 overflow-auto">
			<div className="flex flex-col gap-1">
				<span className="text-sm font-medium text-primary">
					{t("settings.general.fontSize.label")}
				</span>
				<span className="text-xs text-tertiary">
					{t("settings.general.fontSize.desc", {
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
					value={draftFontSize}
					onChange={(e) => {
						setDraftFontSize(Number(e.target.value));
						setSaved(false);
					}}
					className="flex-1 cursor-pointer"
					data-testid="font-size-slider"
				/>
				<span
					className="text-sm text-primary w-12 text-right"
					data-testid="font-size-value"
				>
					{draftFontSize}px
				</span>
			</div>
			<div className="flex flex-col gap-1">
				<span className="text-sm font-medium text-primary">
					{t("settings.general.exportTurns.label")}
				</span>
				<span className="text-xs text-tertiary">
					{t("settings.general.exportTurns.desc", {
						min: EXPORT_TURNS_MIN,
						max: EXPORT_TURNS_MAX,
					})}
				</span>
			</div>
			<div className="flex items-center gap-3 w-72">
				<input
					type="range"
					min={EXPORT_TURNS_MIN}
					max={EXPORT_TURNS_MAX}
					step={1}
					value={draftExportTurns}
					onChange={(e) => {
						setDraftExportTurns(Number(e.target.value));
						setSaved(false);
					}}
					className="flex-1 cursor-pointer"
					data-testid="export-turns-slider"
				/>
				<span
					className="text-sm text-primary w-16 text-right whitespace-nowrap"
					data-testid="export-turns-value"
				>
					{draftExportTurns} {t("settings.general.exportTurns.unit")}
				</span>
			</div>
			{/* 提示音：即时生效，不参与上面的草稿 + 保存流程 */}
			<div className="flex flex-col gap-1">
				<span className="text-sm font-medium text-primary">
					{t("settings.general.sound.label")}
				</span>
				<span className="text-xs text-tertiary">
					{t("settings.general.sound.desc")}
				</span>
			</div>
			<div className="flex items-center justify-between">
				<label
					className="flex items-center gap-2 text-sm text-primary cursor-pointer"
					onClick={() => setSoundTaskDone(!soundTaskDone)}
				>
					{t("settings.general.sound.taskDone")}
					<SoundSwitch
						on={soundTaskDone}
						onToggle={() => setSoundTaskDone(!soundTaskDone)}
						testId="sound-task-done-toggle"
					/>
				</label>
				<button
					onClick={previewTaskDone}
					className="px-2.5 py-1 rounded-sm border border-hairline bg-surface text-xs text-secondary cursor-pointer hover:text-primary transition-colors"
					data-testid="sound-task-done-preview"
				>
					{t("settings.general.sound.preview")}
				</button>
			</div>
			<div className="flex items-center justify-between">
				<label
					className="flex items-center gap-2 text-sm text-primary cursor-pointer"
					onClick={() => setSoundNeedsAction(!soundNeedsAction)}
				>
					{t("settings.general.sound.needsAction")}
					<SoundSwitch
						on={soundNeedsAction}
						onToggle={() => setSoundNeedsAction(!soundNeedsAction)}
						testId="sound-needs-action-toggle"
					/>
				</label>
				<button
					onClick={previewNeedsAction}
					className="px-2.5 py-1 rounded-sm border border-hairline bg-surface text-xs text-secondary cursor-pointer hover:text-primary transition-colors"
					data-testid="sound-needs-action-preview"
				>
					{t("settings.general.sound.preview")}
				</button>
			</div>
			<div className="flex flex-col gap-1">
				<span className="text-sm font-medium text-primary">
					{t("settings.general.retry.label")}
				</span>
				<span className="text-xs text-tertiary">
					{t("settings.general.retry.desc")}
				</span>
			</div>
			<label className="flex flex-col gap-1 w-56">
				<span className="text-xs text-secondary">
					{t("settings.general.retry.maxLabel", { max: MAX_RETRIES })}
				</span>
				<input
					type="number"
					min={0}
					max={MAX_RETRIES}
					step={1}
					value={maxRetries}
					onChange={(e) => {
						setMaxRetries(e.target.value);
						setSaved(false);
					}}
					className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none"
					data-testid="retry-max-input"
				/>
			</label>
			<label className="flex flex-col gap-1 w-56">
				<span className="text-xs text-secondary">
					{t("settings.general.retry.delayLabel", {
						min: MIN_DELAY_S,
						max: MAX_DELAY_S,
					})}
				</span>
				<input
					type="number"
					min={MIN_DELAY_S}
					max={MAX_DELAY_S}
					step={0.5}
					value={delaySeconds}
					onChange={(e) => {
						setDelaySeconds(e.target.value);
						setSaved(false);
					}}
					className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none"
					data-testid="retry-delay-input"
				/>
			</label>
			<label className="flex flex-col gap-1 w-56">
				<span className="text-xs text-secondary">
					{t("settings.general.retry.httpTimeoutLabel")}
				</span>
				<input
					type="number"
					min={10}
					step={10}
					value={httpTimeoutSeconds}
					onChange={(e) => {
						setHttpTimeoutSeconds(e.target.value);
						setSaved(false);
					}}
					className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none"
					data-testid="http-timeout-input"
				/>
			</label>
			<span className="text-xs text-tertiary -mt-1">
				{t("settings.general.retry.httpTimeoutHint")}
			</span>
			{/* 语言切换：草稿态，点保存才生效 */}
			<div className="flex flex-col gap-1">
				<span className="text-sm font-medium text-primary">
					{t("settings.general.language.label")}
				</span>
				<span className="text-xs text-tertiary">
					{t("settings.general.language.desc")}
				</span>
			</div>
			<select
				value={draftLang}
				onChange={(e) => {
					setDraftLang(e.target.value as AppLanguage);
					setSaved(false);
				}}
				className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none w-56"
				data-testid="language-select"
			>
				<option value="zh">{t("settings.general.language.zh")}</option>
				<option value="en">{t("settings.general.language.en")}</option>
			</select>
			<div className="flex items-center gap-3">
				<button
					onClick={() => void handleSave()}
					disabled={saving}
					className={`self-start px-3 py-1.5 rounded-sm text-sm border-0 ${saving ? "text-tertiary cursor-not-allowed" : "cursor-pointer"}`}
					style={
						saving
							? { background: "var(--surface-hover)" }
							: { background: "var(--brand)", color: "var(--on-brand)" }
					}
					data-testid="retry-save-btn"
				>
					{saving ? t("common.saving") : t("common.save")}
				</button>
				{saved && (
					<span className="text-xs text-secondary">{t("common.saved")}</span>
				)}
				{error && (
					<span
						className="text-xs"
						style={{ color: "var(--danger)" }}
						data-testid="retry-save-error"
					>
						{error}
					</span>
				)}
			</div>
		</div>
	);
}
