import { useEffect } from "react";
import { useTranslation } from "../i18n/useTranslation";
import { Modal } from "./ui/Modal";
import { GeneralSection } from "./settings/GeneralSection";
import { AppearanceSection } from "./settings/AppearanceSection";
import { DiagnosticsSection } from "./settings/DiagnosticsSection";
import { ProviderSection } from "./settings/ProviderSection";
import { SkillSection } from "./settings/SkillSection";
import { ExtensionSection } from "./settings/ExtensionSection";
import { MemorySection } from "./settings/MemorySection";
import { McpSection } from "./settings/McpSection";
import { BotsSection } from "./settings/BotsSection";
import { AboutSection } from "./settings/AboutSection";
import { useSettingsStore } from "../store/settings";
import { useUpdaterStore } from "../store/updater";

interface Props {
	onClose: () => void;
}

export function SettingsModal({ onClose }: Props) {
	const activeSection = useSettingsStore((s) => s.activeSection);
	const setSection = useSettingsStore((s) => s.setSection);
	const { t } = useTranslation();

	// 每次打开设置都检查更新（仅桌面版）；showSettings false→true 时触发，
	// 无论当前是否最新版本都重新查一次。
	const showSettings = useSettingsStore(s => s.showSettings);
	const isDesktop = useUpdaterStore(s => s.isDesktop);
	const updaterStatus = useUpdaterStore(s => s.status);
	const checkForUpdates = useUpdaterStore(s => s.checkForUpdates);
	useEffect(() => {
		if (showSettings && isDesktop) void checkForUpdates();
	}, [showSettings, isDesktop, checkForUpdates]);

	// 有新版本且当前不在「关于」tab → 关于按钮显示红点
	const showUpdateDot =
		(updaterStatus === "available" || updaterStatus === "downloaded") &&
		activeSection !== "about";

	return (
		<Modal
			onClose={onClose}
			width="80vw"
			height="80vh"
			data-testid="settings-modal"
		>
			<div className="p-4 border-b border-hairline">
				<span className="text-primary font-bold text-base">
					{t("settings.title")}
				</span>
			</div>
			<div className="flex flex-1 min-h-0">
				{/* 左侧导航：通用 + 外观 + 模型管理 + 技能 */}
				<nav className="w-40 border-r border-hairline p-2 flex flex-col gap-1">
					<button
						onClick={() => setSection("general")}
						className="px-2 py-1.5 rounded-sm text-sm font-medium text-left"
						style={
							activeSection === "general"
								? { background: "var(--accent-soft)", color: "var(--accent)" }
								: { color: "var(--secondary)" }
						}
						data-testid="settings-nav-general"
					>
						{t("settings.nav.general")}
					</button>
					<button
						onClick={() => setSection("appearance")}
						className="px-2 py-1.5 rounded-sm text-sm font-medium text-left"
						style={
							activeSection === "appearance"
								? { background: "var(--accent-soft)", color: "var(--accent)" }
								: { color: "var(--secondary)" }
						}
						data-testid="settings-nav-appearance"
					>
						{t("settings.nav.appearance")}
					</button>
					<button
						onClick={() => setSection("models")}
						className="px-2 py-1.5 rounded-sm text-sm font-medium text-left"
						style={
							activeSection === "models"
								? { background: "var(--accent-soft)", color: "var(--accent)" }
								: { color: "var(--secondary)" }
						}
					>
						{t("settings.nav.models")}
					</button>
					<button
						onClick={() => setSection("skills")}
						className="px-2 py-1.5 rounded-sm text-sm font-medium text-left"
						style={
							activeSection === "skills"
								? { background: "var(--accent-soft)", color: "var(--accent)" }
								: { color: "var(--secondary)" }
						}
					>
						{t("settings.nav.skills")}
					</button>
					<button
						onClick={() => setSection("plugins")}
						className="px-2 py-1.5 rounded-sm text-sm font-medium text-left"
						style={
							activeSection === "plugins"
								? { background: "var(--accent-soft)", color: "var(--accent)" }
								: { color: "var(--secondary)" }
						}
					>
						{t("settings.nav.plugins")}
					</button>
					<button
						onClick={() => setSection("memory")}
						className="px-2 py-1.5 rounded-sm text-sm font-medium text-left"
						style={
							activeSection === "memory"
								? { background: "var(--accent-soft)", color: "var(--accent)" }
								: { color: "var(--secondary)" }
						}
						data-testid="settings-nav-memory"
					>
						{t("settings.nav.memory")}
					</button>
					<button
						onClick={() => setSection("mcp")}
						className="px-2 py-1.5 rounded-sm text-sm font-medium text-left"
						style={
							activeSection === "mcp"
								? { background: "var(--accent-soft)", color: "var(--accent)" }
								: { color: "var(--secondary)" }
						}
						data-testid="settings-nav-mcp"
					>
						{t("settings.nav.mcp")}
					</button>
					<button
						onClick={() => setSection("bots")}
						className="px-2 py-1.5 rounded-sm text-sm font-medium text-left"
						style={
							activeSection === "bots"
								? { background: "var(--accent-soft)", color: "var(--accent)" }
								: { color: "var(--secondary)" }
						}
						data-testid="settings-nav-bots"
					>
						{t("settings.nav.bots")}
					</button>
					<button
						onClick={() => setSection("diagnostics")}
						className="px-2 py-1.5 rounded-sm text-sm font-medium text-left"
						style={
							activeSection === "diagnostics"
								? { background: "var(--accent-soft)", color: "var(--accent)" }
								: { color: "var(--secondary)" }
						}
						data-testid="settings-nav-diagnostics"
					>
						{t("settings.nav.diagnostics")}
					</button>
					<button
						onClick={() => setSection("about")}
						className="relative px-2 py-1.5 rounded-sm text-sm font-medium text-left"
						style={
							activeSection === "about"
								? { background: "var(--accent-soft)", color: "var(--accent)" }
								: { color: "var(--secondary)" }
						}
						data-testid="settings-nav-about"
					>
						{t("settings.nav.about")}
						{showUpdateDot && (
							<span
								className="absolute top-1 right-1.5 w-1.5 h-1.5 rounded-full"
								style={{ background: "var(--danger, #ef4444)" }}
								data-testid="update-badge"
							/>
						)}
					</button>
				</nav>
				{/* 右侧内容 */}
				<div className="flex-1 flex flex-col overflow-hidden">
					{activeSection === "general" && <GeneralSection />}
					{activeSection === "appearance" && <AppearanceSection />}
					{activeSection === "models" && <ProviderSection />}
					{activeSection === "skills" && <SkillSection />}
					{activeSection === "plugins" && <ExtensionSection />}
					{activeSection === "memory" && <MemorySection />}
					{activeSection === "mcp" && <McpSection />}
					{activeSection === "bots" && <BotsSection />}
					{activeSection === "diagnostics" && <DiagnosticsSection />}
					{activeSection === "about" && <AboutSection />}
				</div>
			</div>
		</Modal>
	);
}
