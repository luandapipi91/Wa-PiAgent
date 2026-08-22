import { useEffect, useState } from "react";
import { useTranslation } from "../../i18n/useTranslation";
import { api } from "../../api-client";
import type {
	RetrySettings,
	TrashSettings,
	ProxySettings,
} from "@wa-pi/shared";
import {
	EXPORT_TURNS_MAX,
	EXPORT_TURNS_MIN,
	useUiPrefsStore,
} from "../../store/ui-prefs";
import { useToastStore } from "../../store/toast";
import { previewNeedsAction, previewTaskDone } from "../../util/sound";
import type { AppLanguage } from "../../i18n/detect";

/** 与 kernel settings-store 的产品约束对齐（重试最多 10 次；间隔 0.5s-60s） */
const MAX_RETRIES = 10;
const MIN_DELAY_S = 0.5;
const MAX_DELAY_S = 60;

/** 图片导出范围选项：true=对话双方，false=仅导出 agent 回复。
 *  渲染为 tab 二选一（样式同外观-界面主题）。 */
const EXPORT_INCLUDE_OPTIONS = [{ value: true }, { value: false }];

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
	const [useSystemProxy, setUseSystemProxy] = useState(false);
	const [httpProxy, setHttpProxy] = useState("");
	const [loading, setLoading] = useState(true);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	const exportTurns = useUiPrefsStore((s) => s.exportTurns);
	const setExportTurns = useUiPrefsStore((s) => s.setExportTurns);
	const exportIncludeUser = useUiPrefsStore((s) => s.exportIncludeUser);
	const setExportIncludeUser = useUiPrefsStore((s) => s.setExportIncludeUser);
	const language = useUiPrefsStore((s) => s.language);
	const setLanguage = useUiPrefsStore((s) => s.setLanguage);
	const soundTaskDone = useUiPrefsStore((s) => s.soundTaskDone);
	const setSoundTaskDone = useUiPrefsStore((s) => s.setSoundTaskDone);
	const soundNeedsAction = useUiPrefsStore((s) => s.soundNeedsAction);
	const setSoundNeedsAction = useUiPrefsStore((s) => s.setSoundNeedsAction);
	const autoLaunch = useUiPrefsStore((s) => s.autoLaunch);
	const setAutoLaunch = useUiPrefsStore((s) => s.setAutoLaunch);
	const { t } = useTranslation();
	// 语言草稿：select 改草稿，点保存才 setLanguage 生效；关闭窗口丢弃草稿。
	const [draftLang, setDraftLang] = useState<AppLanguage>(language);
	// 导出轮数草稿：滑块只改草稿，点保存才 setExportTurns 生效，
	// 与语言/重试配置一致（保存后才生效）。关闭窗口不保存则还原（store 仍为原值）。
	const [draftExportTurns, setDraftExportTurns] = useState(exportTurns);
	// 图片导出范围草稿：tab 只改草稿，点保存才 setExportIncludeUser 生效。
	const [draftExportIncludeUser, setDraftExportIncludeUser] =
		useState(exportIncludeUser);
	// 回收站自动归档/清理设置：草稿态，点保存才生效
	const [autoArchive, setAutoArchive] = useState(true);
	const [archiveDays, setArchiveDays] = useState("7");
	const [autoPurge, setAutoPurge] = useState(false);
	const [purgeDays, setPurgeDays] = useState("30");

	useEffect(() => {
		api
			.get("/api/settings/retry")
			.then((res) => {
				const retry = (res as any)?.retry as RetrySettings | undefined;
				if (retry) {
					setMaxRetries(String(retry.maxRetries));
					setDelaySeconds(String(retry.baseDelayMs / 1000));
				}
				const httpIdleMs = (res as any)?.httpIdleTimeoutMs as number | undefined;
				if (typeof httpIdleMs === "number") {
					setHttpTimeoutSeconds(String(Math.round(httpIdleMs / 1000)));
				}
			})
			.catch((e) => setError(e instanceof Error ? e.message : String(e)))
			.finally(() => setLoading(false));
	}, []);
	// 回收站设置单独加载（GET /api/settings/trash），失败静默、沿用默认值
	useEffect(() => {
		api
			.get("/api/settings/trash")
			.then((res) => {
				const trash = (res as { trash?: TrashSettings })?.trash;
				if (trash) {
					setAutoArchive(trash.autoArchiveEnabled);
					setArchiveDays(String(trash.autoArchiveDays));
					setAutoPurge(trash.autoPurgeEnabled);
					setPurgeDays(String(trash.autoPurgeDays));
				}
			})
			.catch(() => {});
	}, []);
	// 系统代理设置单独加载（GET /api/settings/proxy），失败静默、沿用默认值
	useEffect(() => {
		api
			.get("/api/settings/proxy")
			.then((res) => {
				const proxy = (res as { proxy?: ProxySettings })?.proxy;
				if (proxy) {
					setUseSystemProxy(proxy.useSystemProxy);
					setHttpProxy(proxy.httpProxy);
				}
			})
			.catch(() => {});
	}, []);

	const saveTrashSettings = async () => {
		await api.put("/api/settings/trash", {
			trash: {
				autoArchiveEnabled: autoArchive,
				autoArchiveDays: Math.max(1, Number(archiveDays) || 7),
				autoPurgeEnabled: autoPurge,
				autoPurgeDays: Math.max(1, Number(purgeDays) || 30),
			},
		});
	};

	// 开机自启：mount 时将 store 偏好同步到系统
	useEffect(() => {
		window.waPiApp?.setLoginItem?.(autoLaunch);
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
			await saveTrashSettings();
			// 系统代理：httpProxy 由 kernel 读系统代理兑底（网页端无 Electron IPC）
			await api.put("/api/settings/proxy", {
				proxy: { useSystemProxy, httpProxy: "" },
			});
			// 导出轮数草稿生效（仅当与当前值不同时才写入）
			if (draftExportTurns !== exportTurns) setExportTurns(draftExportTurns);
			// 图片导出范围草稿生效（仅当与当前值不同时才写入）
			if (draftExportIncludeUser !== exportIncludeUser)
				setExportIncludeUser(draftExportIncludeUser);
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
		return <div className="p-4 text-sm text-tertiary">{t("common.loading")}</div>;
	}

	return (
		<div className="flex flex-col gap-4 p-4 overflow-auto">
			{/* 自动重试：草稿态，点保存才生效 */}
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
			{/* 系统代理：草稿态，点保存才生效 */}
			<div className="flex items-center justify-between">
				<span className="text-sm text-primary" style={{ marginRight: 15 }}>
					{t("settings.general.proxy.label")}
				</span>
				<SoundSwitch
					on={useSystemProxy}
					onToggle={() => {
						setUseSystemProxy(!useSystemProxy);
						setSaved(false);
					}}
					testId="use-system-proxy-toggle"
				/>
			</div>
			<div className="border-t border-hairline" />
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
				<div className="flex items-center">
					<span className="text-sm text-primary" style={{ marginRight: 15 }}>
						{t("settings.general.sound.taskDone")}
					</span>
					<button
						onClick={previewTaskDone}
						className="px-2.5 py-1 rounded-sm border border-hairline bg-surface text-xs text-secondary cursor-pointer hover:text-primary transition-colors"
						data-testid="sound-task-done-preview"
					>
						{t("settings.general.sound.preview")}
					</button>
				</div>
				<SoundSwitch
					on={soundTaskDone}
					onToggle={() => setSoundTaskDone(!soundTaskDone)}
					testId="sound-task-done-toggle"
				/>
			</div>
			<div className="flex items-center justify-between">
				<div className="flex items-center">
					<span className="text-sm text-primary" style={{ marginRight: 15 }}>
						{t("settings.general.sound.needsAction")}
					</span>
					<button
						onClick={previewNeedsAction}
						className="px-2.5 py-1 rounded-sm border border-hairline bg-surface text-xs text-secondary cursor-pointer hover:text-primary transition-colors"
						data-testid="sound-needs-action-preview"
					>
						{t("settings.general.sound.preview")}
					</button>
				</div>
				<SoundSwitch
					on={soundNeedsAction}
					onToggle={() => setSoundNeedsAction(!soundNeedsAction)}
					testId="sound-needs-action-toggle"
				/>
			</div>
			<div className="border-t border-hairline" />
			{/* 会话回收站：草稿态，点保存才生效 */}
			<div>
				<span className="text-sm font-medium text-primary block mb-3">
					{t("settings.trashSection")}
				</span>
				{/* 自动归档开关 */}
				<div className="flex items-center justify-between mb-2">
					<span className="text-sm text-primary">
						{t("settings.trashAutoArchive")}
					</span>
					<SoundSwitch
						on={autoArchive}
						onToggle={() => {
							setAutoArchive(!autoArchive);
							setSaved(false);
						}}
						testId="trash-auto-archive-toggle"
					/>
				</div>
				<div
					className={`flex items-center gap-2 mb-4 ${autoArchive ? "" : "opacity-40"}`}
				>
					<input
						type="number"
						min={1}
						max={365}
						value={archiveDays}
						onChange={(e) => {
							setArchiveDays(e.target.value);
							setSaved(false);
						}}
						disabled={!autoArchive}
						className="w-16 px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary text-center outline-none"
						data-testid="trash-archive-days-input"
					/>
					<span className="text-xs text-tertiary">
						{t("settings.trashArchiveDays", { days: archiveDays })}
					</span>
				</div>
				{/* 自动清理开关 */}
				<div className="flex items-center justify-between mb-2">
					<span className="text-sm text-primary">
						{t("settings.trashAutoPurge")}
					</span>
					<SoundSwitch
						on={autoPurge}
						onToggle={() => {
							setAutoPurge(!autoPurge);
							setSaved(false);
						}}
						testId="trash-auto-purge-toggle"
					/>
				</div>
				<div className={`flex items-center gap-2 ${autoPurge ? "" : "opacity-40"}`}>
					<input
						type="number"
						min={1}
						max={365}
						value={purgeDays}
						onChange={(e) => {
							setPurgeDays(e.target.value);
							setSaved(false);
						}}
						disabled={!autoPurge}
						className="w-16 px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary text-center outline-none"
						data-testid="trash-purge-days-input"
					/>
					<span className="text-xs text-tertiary">
						{t("settings.trashPurgeDays", { days: purgeDays })}
					</span>
				</div>
			</div>
			<div className="border-t border-hairline" />
			{/* 对话导出分组：导出轮数 + 图片导出范围（副标题「对话导出」） */}
			<span className="text-sm font-medium text-primary block mb-3">
				{t("settings.exportSection")}
			</span>
			{/* 对话导出轮数：草稿态，点保存才生效 */}
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
			{/* 图片导出范围：tab 二选一，右对齐（与提示音/开机自启等开关同行布局），
			    草稿态，点保存才生效（样式同外观-界面主题） */}
			<div className="flex items-center justify-between gap-4">
				<div className="flex flex-col gap-1">
					<span className="text-sm font-medium text-primary">
						{t("settings.general.exportIncludeUser.label")}
					</span>
					<span className="text-xs text-tertiary">
						{t("settings.general.exportIncludeUser.desc")}
					</span>
				</div>
				<div className="inline-flex shrink-0 bg-surface-hover rounded-md p-0.5">
					{EXPORT_INCLUDE_OPTIONS.map((opt) => (
						<button
							key={String(opt.value)}
							onClick={() => {
								setDraftExportIncludeUser(opt.value);
								setSaved(false);
							}}
							data-testid={`export-include-user-${opt.value ? "both" : "agent-only"}`}
							data-active={draftExportIncludeUser === opt.value ? "true" : "false"}
							className="px-3 py-1.5 rounded-sm text-sm transition-all"
							style={
								draftExportIncludeUser === opt.value
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
							{t(
								opt.value
									? "settings.general.exportIncludeUser.both"
									: "settings.general.exportIncludeUser.agentOnly",
							)}
						</button>
					))}
				</div>
			</div>
			<div className="border-t border-hairline" />
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
			<div className="border-t border-hairline" />
			{/* 开机自启：即时生效（经 IPC 同步系统） */}
			{typeof window !== "undefined" && window.waPiApp?.setLoginItem && (
				<div className="flex items-center">
					<span className="text-sm text-primary" style={{ marginRight: 15 }}>
						{t("settings.general.autoLaunch")}
					</span>
					<div className="flex-1" />
					<SoundSwitch
						on={autoLaunch}
						onToggle={() => {
							const v = !autoLaunch;
							setAutoLaunch(v);
							window.waPiApp?.setLoginItem?.(v);
						}}
						testId="auto-launch-toggle"
					/>
				</div>
			)}
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
