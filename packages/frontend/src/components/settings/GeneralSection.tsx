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
import type { AppLanguage } from "../../i18n/detect";

/** 与 kernel settings-store 的产品约束对齐（重试最多 10 次；间隔 0.5s-60s） */
const MAX_RETRIES = 10;
const MIN_DELAY_S = 0.5;
const MAX_DELAY_S = 60;

/**
 * 通用设置：pi 自动重试配置（transient 错误——网络/超时/5xx/限流——后的自动重试）。
 * 保存到 settings.json.retry，pi 进程启动时加载；kernel 保存后会标脏活跃会话，
 * 下次发消息时重建进程生效。
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
	const { t } = useTranslation();

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
			setSaved(true);
		} catch (e) {
			// 保存失败：用 toast 提示，不再在按钮旁显示 inline 文本
			// （加载配置失败的 error state 仍保留 inline，由 useEffect 设置）
			useToastStore.getState().add(e instanceof Error ? e.message : String(e), "error");
		} finally {
			setSaving(false);
		}
	};

	if (loading) {
		return <div className="p-4 text-sm text-tertiary">{t("common.loading")}</div>;
	}

	return (
		<div className="flex flex-col gap-4 p-4 overflow-auto">
			<div className="flex flex-col gap-1">
				<span className="text-sm font-medium text-primary">{t("settings.general.fontSize.label")}</span>
				<span className="text-xs text-tertiary">
					{t("settings.general.fontSize.desc", { min: FONT_SIZE_MIN, max: FONT_SIZE_MAX })}
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
					style={{ accentColor: "var(--brand)" }}
					data-testid="font-size-slider"
				/>
				<span
					className="text-sm text-primary w-12 text-right"
					data-testid="font-size-value"
				>
					{fontSize}px
				</span>
			</div>
			<div className="flex flex-col gap-1">
				<span className="text-sm font-medium text-primary">{t("settings.general.exportTurns.label")}</span>
				<span className="text-xs text-tertiary">
					{t("settings.general.exportTurns.desc", { min: EXPORT_TURNS_MIN, max: EXPORT_TURNS_MAX })}
				</span>
			</div>
			<div className="flex items-center gap-3 w-72">
				<input
					type="range"
					min={EXPORT_TURNS_MIN}
					max={EXPORT_TURNS_MAX}
					step={1}
					value={exportTurns}
					onChange={(e) => setExportTurns(Number(e.target.value))}
					className="flex-1 cursor-pointer"
					style={{ accentColor: "var(--brand)" }}
					data-testid="export-turns-slider"
				/>
				<span
					className="text-sm text-primary w-12 text-right"
					data-testid="export-turns-value"
				>
					{exportTurns} {t("settings.general.exportTurns.unit")}
				</span>
			</div>
			<div className="flex flex-col gap-1">
				<span className="text-sm font-medium text-primary">{t("settings.general.retry.label")}</span>
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
					{t("settings.general.retry.delayLabel", { min: MIN_DELAY_S, max: MAX_DELAY_S })}
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
				<span className="text-xs text-secondary">{t("settings.general.retry.httpTimeoutLabel")}</span>
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
					{saved && <span className="text-xs text-secondary">{t("common.saved")}</span>}
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
			<div className="flex flex-col gap-1">
				<span className="text-sm font-medium text-primary">{t("settings.general.language.label")}</span>
				<span className="text-xs text-tertiary">
					{t("settings.general.language.desc")}
				</span>
			</div>
			<select
				value={language}
				onChange={(e) => setLanguage(e.target.value as AppLanguage)}
				className="px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none w-56"
				data-testid="language-select"
			>
				<option value="zh">{t("settings.general.language.zh")}</option>
				<option value="en">{t("settings.general.language.en")}</option>
			</select>
		</div>
	);
}
