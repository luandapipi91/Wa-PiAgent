import { useUpdaterStore } from "../../store/updater";
import { useSettingsStore } from "../../store/settings";
import { useOnboardingStore } from "../../store/onboarding";
import { useTranslation } from "../../i18n/useTranslation";
import { Icon } from "../ui/Icon";
import { VersionTimeline } from "./VersionTimeline";

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
 * 「关于」页签：展示应用名/版本，并接入 updater store 渲染 6 种更新状态
 * （idle / checking / available / downloading / downloaded / error，外加 up-to-date）。
 * 非桌面环境（浏览器）隐藏更新控件，仅提示。所有文案走 i18n（settings.about.*）。
 */
export function AboutSection() {
	const {
		status,
		appVersion,
		kernelVersion,
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
	const { t } = useTranslation();

	const showUpdateControls = isDesktop;
	const ver = latestVersion ? `v${latestVersion}` : "";

	return (
		<div
			className="flex flex-col items-center p-8 overflow-auto gap-0"
			data-testid="about-section"
		>
			<img
				src="/logo.svg"
				alt="WA PI Agent"
				className="w-24 h-24 rounded-[22px] shadow-md"
				draggable={false}
			/>
			<div className="mt-4 text-lg font-semibold text-primary">WA PI Agent</div>
			<div className="mt-1 text-[13px] text-secondary">
				{t("settings.about.version", { version: appVersion || "—" })}
			</div>
			<div className="mt-1 text-[13px] text-secondary">
				{t("settings.about.kernelVersion", {
					version: kernelVersion || "—",
				})}
			</div>
			<div
				className="w-[280px] h-px my-5"
				style={{ background: "var(--hairline)" }}
			/>

			{!showUpdateControls ? (
				<div className="text-xs text-tertiary">
					{t("settings.about.desktopOnly")}
				</div>
			) : (
				<div
					className="flex flex-col items-center gap-3 w-[340px]"
					data-testid="updater-status"
				>
					{status === "idle" && (
						<button
							className="px-6 py-2 rounded-sm text-sm font-medium border-0 cursor-pointer"
							style={{ background: "var(--brand)", color: "var(--on-brand)" }}
							onClick={() => void checkForUpdates(true)}
							data-testid="check-update-btn"
						>
							{t("settings.about.checkUpdate")}
						</button>
					)}

					{status === "checking" && (
						<div className="flex items-center gap-2 text-sm text-primary">
							<span
								className="inline-block w-3.5 h-3.5 rounded-full border-2"
								style={{
									borderColor: "var(--hairline-strong)",
									borderTopColor: "var(--accent)",
								}}
							/>
							{t("settings.about.checking")}
						</div>
					)}

					{status === "available" && (
						<>
							<div className="text-sm text-primary">
								{t("settings.about.foundNew")} <b>{ver}</b>
							</div>
							{releaseNotes && (
								<div className="text-xs text-tertiary text-center leading-5 max-w-[340px] whitespace-pre-wrap">
									{releaseNotes}
								</div>
							)}
							<button
								className="px-5 py-2 rounded-sm text-sm font-medium border-0 cursor-pointer"
								style={{
									background: "var(--accent)",
									color: "var(--on-accent)",
								}}
								onClick={() => void downloadUpdate()}
								data-testid="download-update-btn"
							>
								{t("settings.about.downloadNow")}
							</button>
						</>
					)}

					{status === "downloading" && (
						<>
							<div className="text-sm text-primary">
								{t("settings.about.downloading")} {ver}…
							</div>
							<div
								className="w-full h-1.5 rounded-full overflow-hidden"
								style={{ background: "var(--surface-hover)" }}
							>
								<div
									className="h-full rounded-full transition-all duration-300"
									style={{
										width: `${Math.min(100, progress)}%`,
										background: "var(--accent)",
									}}
									data-testid="download-progress-bar"
								/>
							</div>
							<div className="w-full flex justify-between text-xs text-secondary">
								<span>{Math.round(progress)}%</span>
								<span>
									{fmtBytes(transferred)} / {fmtBytes(total)}
								</span>
							</div>
						</>
					)}

					{status === "downloaded" && (
						<>
							<div
								className="text-sm font-medium"
								style={{ color: "var(--success)" }}
							>
								{t("settings.about.downloaded")}
							</div>
							<div className="text-xs text-secondary">
								{t("settings.about.downloadedHint", {
									version: latestVersion ?? "",
								})}
							</div>
							<button
								className="px-5 py-2 rounded-sm text-sm font-medium border-0 cursor-pointer"
								style={{ background: "var(--success)", color: "#fff" }}
								onClick={() => void quitAndInstall()}
								data-testid="install-update-btn"
							>
								{t("settings.about.restartInstall")}
							</button>
						</>
					)}

					{status === "installing" && (
						<>
							<div className="text-sm font-medium text-primary">
								{t("settings.about.installing")}
							</div>
							<div
								className="w-5 h-5 rounded-full border-2 border-transparent animate-spin mt-1"
								style={{
									borderTopColor: "var(--accent)",
									borderRightColor: "var(--accent)",
								}}
								data-testid="install-spinner"
							/>
						</>
					)}

					{status === "up-to-date" && (
						<div className="text-sm" style={{ color: "var(--success)" }}>
							{t("settings.about.upToDate")} ✓
						</div>
					)}

					{status === "error" && (
						<>
							<div className="text-sm" style={{ color: "var(--danger)" }}>
								{error || t("settings.about.updateFailed")}
							</div>
							<button
								className="px-4 py-1.5 rounded-sm text-sm border cursor-pointer"
								style={{
									borderColor: "var(--hairline-strong)",
									color: "var(--text-secondary)",
									background: "transparent",
								}}
								onClick={() => void checkForUpdates(true)}
								data-testid="retry-update-btn"
							>
								{t("settings.about.retry")}
							</button>
						</>
					)}
				</div>
			)}

			{/* 更新历史时间线：max-height + 独立滚动，不挤压上方更新控件 */}
			<div className="w-full max-w-[480px] mt-2">
				<div className="text-xs font-medium text-secondary mb-3">
					{t("settings.about.updateHistory")}
				</div>
				<div className="max-h-[400px] overflow-y-auto">
					<VersionTimeline />
				</div>
			</div>

			{/* 初始化引导入口：说明文字后跟 icon 按钮（关闭设置并重开新手向导） */}
			<div className="mt-5 flex items-center gap-1.5 text-xs text-tertiary">
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
