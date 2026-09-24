import { useEffect, useMemo, useState } from "react";
import { useUpdaterStore } from "../../store/updater";
import { useSettingsStore } from "../../store/settings";
import { useOnboardingStore } from "../../store/onboarding";
import { useVersionHistoryStore } from "../../store/version-history";
import { useTranslation } from "../../i18n/useTranslation";
import { Icon } from "../ui/Icon";
import { VersionTimeline } from "./VersionTimeline";
import { VersionEntryBody } from "./VersionEntryBody";
import { countItems, selectUpdatesBetween } from "../../util/version-history";

/** 官网地址（Cloudflare R2 公开域名；R2 无默认首页，需带 /index.html 完整路径） */
const WEBSITE_URL = "https://www.wapiagent.top/index.html";
/** GitHub 公开仓库地址 */
const GITHUB_URL = "https://github.com/luandapipi91/Wa-PiAgent";

/** 字节数格式化：B / KB / MB / GB */
function fmtBytes(n: number): string {
	if (!n) return "0 B";
	if (n >= 1024 * 1024 * 1024)
		return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
	if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
	if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${n} B`;
}

/**
 * 「关于」页签：Hero 横排（logo / 名称 / 版本 / 官网 / GitHub / 检查更新），
 * 更新状态条（有新版本时给「跨 N 个版本 · 共 M 项变更」摘要，可原地展开各版本内容），
 * 更新历史左右分栏（数据来自 useVersionHistoryStore，最多 100 个版本）。
 * 更新内容区间 = 当前安装版 < v <= 线上最新版；拉不到线上数据时退回 releaseNotes。
 */
export function AboutSection() {
	const {
		status,
		appVersion,
		latestVersion,
		releaseNotes,
		progress,
		transferred,
		total,
		error,
		isDesktop,
		checkForUpdates,
		downloadUpdate,
		quitAndInstall,
	} = useUpdaterStore();
	const entries = useVersionHistoryStore((s) => s.entries);
	const loadHistory = useVersionHistoryStore((s) => s.load);
	const { t } = useTranslation();
	const [showBetween, setShowBetween] = useState(false);

	// 打开设置即刷新版本历史（与 SettingsModal 的自动检查更新同频）
	useEffect(() => {
		void loadHistory();
	}, [loadHistory]);

	const ver = latestVersion ? `v${latestVersion}` : "";
	// 安装版 → 最新版之间的全部版本（含中间跳过的版本）
	const pending = useMemo(() => {
		if (!latestVersion) return [];
		return selectUpdatesBetween(entries, appVersion, latestVersion);
	}, [entries, appVersion, latestVersion]);
	const pendingItems = pending.reduce((n, e) => n + countItems(e), 0);

	const showStatusBar =
		isDesktop &&
		(status === "available" ||
			status === "downloading" ||
			status === "downloaded" ||
			status === "installing" ||
			status === "error");

	return (
		<div
			className="flex flex-col h-full overflow-hidden"
			data-testid="about-section"
		>
			{/* Hero：logo 横排 + 名称/版本/官网/GitHub + 右侧状态与按钮 */}
			<div className="flex items-center gap-3.5 px-6 pt-5 pb-3.5">
				<img
					src="/logo.svg"
					alt="WA PI Agent"
					className="w-14 h-14 rounded-2xl shadow-sm shrink-0"
					draggable={false}
				/>
				<div className="min-w-0">
					<div className="text-[15px] font-semibold text-primary leading-tight">
						WA PI Agent
					</div>
					<div className="mt-0.5 flex items-center gap-1.5 flex-wrap text-xs text-secondary">
						<span>{t("settings.about.version", { version: appVersion || "—" })}</span>
						<span className="text-tertiary">·</span>
						<a
							data-testid="about-website-link"
							href={WEBSITE_URL}
							target="_blank"
							rel="noreferrer"
							className="inline-flex items-center gap-1 hover:underline"
							style={{ color: "var(--brand)" }}
						>
							<Icon name="globe" size={13} />
							{t("settings.about.website")}
						</a>
						<span className="text-tertiary">·</span>
						<a
							data-testid="about-github-link"
							href={GITHUB_URL}
							target="_blank"
							rel="noreferrer"
							className="inline-flex items-center gap-1 hover:underline"
							style={{ color: "var(--brand)" }}
						>
							<Icon name="github" size={13} />
							{t("settings.about.github")}
						</a>
					</div>
				</div>

				{isDesktop ? (
					<div className="ml-auto flex items-center gap-2.5 shrink-0">
						{status === "checking" && (
							<span className="inline-flex items-center gap-2 text-xs text-tertiary">
								<span
									className="inline-block w-3 h-3 rounded-full border-2 animate-spin"
									style={{
										borderColor: "var(--hairline-strong)",
										borderTopColor: "var(--accent)",
									}}
								/>
								{t("settings.about.checking")}
							</span>
						)}
						{status === "up-to-date" && (
							<span className="text-xs text-tertiary">
								{t("settings.about.upToDate")}
							</span>
						)}
						{(status === "idle" || status === "up-to-date") && (
							<button
								data-testid="check-update-btn"
								onClick={() => void checkForUpdates(true)}
								className="px-3.5 py-1.5 rounded-sm text-[13px] font-medium cursor-pointer"
								style={
									status === "idle"
										? {
												background: "var(--brand)",
												color: "var(--on-brand)",
												border: "none",
											}
										: {
												background: "transparent",
												color: "var(--text-primary)",
												border: "1px solid var(--hairline)",
											}
								}
							>
								{t("settings.about.checkUpdate")}
							</button>
						)}
					</div>
				) : (
					<div className="ml-auto text-xs text-tertiary shrink-0">
						{t("settings.about.desktopOnly")}
					</div>
				)}
			</div>

			{/* 更新状态条：有新版本/下载/安装/出错时出现 */}
			{showStatusBar && (
				<div
					data-testid="updater-status"
					className="mx-6 mb-1.5 px-3.5 py-3 rounded-md flex items-start gap-3"
					style={{ background: "var(--surface-hover)" }}
				>
					<span
						className="inline-flex items-center justify-center w-[26px] h-[26px] rounded-full shrink-0 mt-px"
						style={
							status === "error"
								? { background: "var(--danger-soft)", color: "var(--danger)" }
								: { background: "var(--accent-soft)", color: "var(--brand)" }
						}
					>
						<Icon name={status === "error" ? "warning" : "download"} size={13} />
					</span>

					<div className="flex-1 min-w-0">
						{status === "available" && (
							<div className="text-[13px] font-medium text-primary">
								{t("settings.about.foundNew")} <b>{ver}</b>
							</div>
						)}
						{status === "downloading" && (
							<div className="text-[13px] font-medium text-primary">
								{t("settings.about.downloading")} {ver}…
							</div>
						)}
						{status === "downloaded" && (
							<>
								<div
									className="text-[13px] font-medium"
									style={{ color: "var(--success)" }}
								>
									{t("settings.about.downloaded")}
								</div>
								<div className="mt-0.5 text-xs text-secondary">
									{t("settings.about.downloadedHint", {
										version: latestVersion ?? "",
									})}
								</div>
							</>
						)}
						{status === "installing" && (
							<div className="text-[13px] font-medium text-primary">
								{t("settings.about.installing")}
							</div>
						)}
						{status === "error" && (
							<div
								className="text-[13px] font-medium"
								style={{ color: "var(--danger)" }}
							>
								{error || t("settings.about.updateFailed")}
							</div>
						)}

						{/* available：区间摘要（跨 N 个版本）+ 原地展开各版本内容；无区间数据退 releaseNotes */}
						{status === "available" && pending.length > 0 && (
							<div className="mt-1">
								<div className="flex items-center gap-2 text-xs text-secondary">
									<span>
										{t("settings.about.updatesBetween", {
											versions: pending.length,
											items: pendingItems,
										})}
									</span>
									<button
										type="button"
										data-testid="toggle-pending-versions"
										onClick={() => setShowBetween((v) => !v)}
										className="inline-flex items-center gap-1 cursor-pointer bg-transparent border-0 p-0 text-xs"
										style={{ color: "var(--brand)" }}
									>
										{showBetween
											? t("settings.about.collapse")
											: t("settings.about.viewAll")}
										<Icon
											name={showBetween ? "chevron-up" : "chevron-down"}
											size={12}
										/>
									</button>
								</div>
								{showBetween && (
									<div
										data-testid="pending-versions"
										className="mt-2 max-h-[220px] overflow-y-auto pr-1"
									>
										{pending.map((entry) => (
											<div key={entry.version} className="mb-3 last:mb-0">
												<div className="flex items-baseline gap-2 mb-1.5">
													<span className="text-xs font-medium text-primary">
														v{entry.version}
													</span>
													<span className="text-[11px] text-tertiary">
														{entry.date}
													</span>
												</div>
												<VersionEntryBody entry={entry} />
											</div>
										))}
									</div>
								)}
							</div>
						)}
						{status === "available" && pending.length === 0 && releaseNotes && (
							<div className="mt-1 text-xs text-secondary leading-relaxed whitespace-pre-wrap line-clamp-3">
								{releaseNotes}
							</div>
						)}

						{status === "downloading" && (
							<>
								<div
									className="mt-2 h-1 rounded-full overflow-hidden"
									style={{ background: "var(--hairline)" }}
								>
									<div
										className="h-full rounded-full transition-all duration-300"
										style={{
											width: `${Math.min(100, progress)}%`,
											background: "var(--brand)",
										}}
										data-testid="download-progress-bar"
									/>
								</div>
								<div className="mt-1 flex justify-between text-xs text-secondary">
									<span>{Math.round(progress)}%</span>
									<span>
										{fmtBytes(transferred)} / {fmtBytes(total)}
									</span>
								</div>
							</>
						)}
					</div>

					<div className="shrink-0 mt-0.5 flex items-center gap-2">
						{status === "available" && (
							<button
								className="px-4 py-1.5 rounded-sm text-[13px] font-medium border-0 cursor-pointer"
								style={{
									background: "var(--accent)",
									color: "var(--on-accent)",
								}}
								onClick={() => void downloadUpdate()}
								data-testid="download-update-btn"
							>
								{t("settings.about.downloadNow")}
							</button>
						)}
						{status === "downloaded" && (
							<button
								className="px-4 py-1.5 rounded-sm text-[13px] font-medium border-0 cursor-pointer"
								style={{ background: "var(--success)", color: "#fff" }}
								onClick={() => void quitAndInstall()}
								data-testid="install-update-btn"
							>
								{t("settings.about.restartInstall")}
							</button>
						)}
						{status === "installing" && (
							<span
								className="inline-block w-4 h-4 rounded-full border-2 border-transparent animate-spin"
								style={{
									borderTopColor: "var(--accent)",
									borderRightColor: "var(--accent)",
								}}
								data-testid="install-spinner"
							/>
						)}
						{status === "error" && (
							<button
								className="px-3.5 py-1.5 rounded-sm text-[13px] cursor-pointer"
								style={{
									border: "1px solid var(--hairline-strong)",
									color: "var(--text-secondary)",
									background: "transparent",
								}}
								onClick={() => void checkForUpdates(true)}
								data-testid="retry-update-btn"
							>
								{t("settings.about.retry")}
							</button>
						)}
					</div>
				</div>
			)}

			{/* 更新历史：标题行 + 左右分栏（分栏自身滚动，页面不整页滚） */}
			<div className="flex-1 min-h-0 flex flex-col px-6">
				<div className="flex items-baseline justify-between pt-3 pb-2 text-xs font-medium text-secondary">
					<span>{t("settings.about.updateHistory")}</span>
					<span className="text-[11px] font-normal text-tertiary">
						{t("settings.about.versionsCount", { count: entries.length })}
					</span>
				</div>
				<VersionTimeline />
			</div>

			{/* 初始化引导入口：说明文字后跟 icon 按钮（关闭设置并重开新手向导） */}
			<div className="shrink-0 flex items-center justify-center gap-1.5 px-6 pt-3 pb-4 text-xs text-tertiary">
				<span>{t("settings.about.onboardingDesc")}</span>
				<button
					data-testid="reopen-onboarding"
					title={t("settings.about.onboardingButton")}
					aria-label={t("settings.about.onboardingButton")}
					onClick={() => {
						useSettingsStore.getState().close();
						useOnboardingStore.getState().openWizard();
					}}
					className="inline-flex items-center justify-center w-6 h-6 rounded-sm border border-hairline text-secondary hover:text-primary cursor-pointer"
				>
					<Icon name="rocket" size={13} />
				</button>
			</div>
		</div>
	);
}
