import { useState, useEffect, Fragment } from "react";
import type { View } from "../App";
import { LogoFrog } from "./ui/frog/LogoFrog";
import { AgentListSection } from "./AgentListSection";
import { ProjectList } from "./ProjectList";
import { SettingsButton } from "./SettingsButton";
import { RecycleBinButton } from "./RecycleBinButton";
import { RecycleBinModal } from "./RecycleBinModal";
import { ImConversationList } from "./ImConversationList";
import { RecentSessionsList } from "./RecentSessionsList";
import { AutomationSidebar } from "./automation/AutomationSidebar";
import { useSettingsStore } from "../store/settings";
import { useSidebarStore } from "../store/sidebar";
import { useTrashStore } from "../store/trash";
import { useTranslation } from "../i18n/useTranslation";

/** 侧边栏分段标签 */
export type SidebarTab = "tasks" | "im" | "automation";

interface Props {
	onNewSession: () => void;
	onMore: () => void;
	onSelectSession: (id: string) => void;
	onNewSessionInProject: (projectId: string) => void;
	onSelectProject: (projectId: string) => void;
	onNewProject: () => void;
	currentView?: View;
	/** 当前激活的分段标签（受控，由 App.tsx 管理以驱动主内容区路由） */
	tab: SidebarTab;
	onTabChange: (tab: SidebarTab) => void;
}

export function Sidebar(props: Props) {
	const width = useSidebarStore((s) => s.width);
	const { t } = useTranslation();
	// tab 由 App.tsx 控制（主内容区需据此切换自动化视图）
	const { tab, onTabChange: setTab } = props;
	// 任务视图内次级维度：项目（按项目分组，默认）| 最近（时间线）
	const [sessionScope, setSessionScope] = useState<"project" | "recent">(
		"project",
	);
	const [showTrash, setShowTrash] = useState(false);
	const trashCount = useTrashStore((s) => s.badgeCount);
	const refreshBadge = useTrashStore((s) => s.refreshBadge);
	useEffect(() => {
		void refreshBadge();
	}, [refreshBadge]);
	return (
		<aside
			className="flex flex-col gap-1.5 p-3.5 overflow-hidden border-r border-hairline"
			style={{ width, background: "var(--surface-elevated)" }}
			data-testid="sidebar"
		>
			<div className="flex items-center gap-2 px-2 pb-2.5 min-w-0">
				<LogoFrog width={width} />
			</div>
			<AgentListSection onMore={props.onMore} />
			{/* 任务 | IM | 自动化 分段控件 */}
			<div
				className="flex rounded-md p-0.5"
				style={{ background: "var(--surface-hover)" }}
			>
				{(["tasks", "im", "automation"] as const).map((tabKey) => (
					<button
						key={tabKey}
						onClick={() => setTab(tabKey)}
						className="flex-1 text-xs font-medium py-1 rounded-sm border-0 cursor-pointer"
						style={
							tab === tabKey
								? {
										background: "var(--surface)",
										color: "var(--text-primary)",
										boxShadow: "var(--shadow-sm)",
									}
								: { background: "transparent", color: "var(--text-secondary)" }
						}
						data-testid={`sidebar-tab-${tabKey}`}
					>
						{tabKey === "tasks"
							? t("sidebar.tabTasks")
							: tabKey === "im"
								? t("sidebar.tabIm")
								: t("sidebar.tabAutomation")}
					</button>
				))}
			</div>
			{tab === "automation" ? (
				<AutomationSidebar />
			) : tab === "tasks" ? (
				<>
					{/* 任务视图内查看维度：项目分组 | 最近时间线（虚线样式，区分于上方任务|IM 实心分段） */}
					<div
						className="flex rounded-md p-0.5"
						style={{ border: "1px dashed var(--hairline-strong)" }}
						data-testid="session-scope"
					>
						{(["project", "recent"] as const).map((scopeKey, idx) => (
							<Fragment key={scopeKey}>
								{idx > 0 && (
									<span
										className="self-stretch my-1"
										style={{
											borderLeftWidth: "1px",
											borderLeftStyle: "dashed",
											borderLeftColor: "var(--hairline-strong)",
										}}
										data-testid="session-scope-divider"
										aria-hidden="true"
									/>
								)}
								<button
									onClick={() => setSessionScope(scopeKey)}
									className="flex-1 text-xs font-medium py-1 rounded-sm border-0 cursor-pointer"
									style={
										sessionScope === scopeKey
											? {
													color: "var(--text-primary)",
													fontWeight: "bold",
												}
											: {
													background: "transparent",
													color: "var(--text-secondary)",
												}
									}
									data-testid={
										scopeKey === "project"
											? "session-scope-project"
											: "session-scope-recent"
									}
								>
									{scopeKey === "project"
										? t("sidebar.scopeProject")
										: t("sidebar.scopeRecent")}
								</button>
							</Fragment>
						))}
					</div>
					{sessionScope === "project" ? (
						<ProjectList
							onSelectSession={props.onSelectSession}
							onNewSessionInProject={props.onNewSessionInProject}
							onSelectProject={props.onSelectProject}
							onNewProject={props.onNewProject}
							currentView={props.currentView}
						/>
					) : (
						<RecentSessionsList
							onSelectSession={props.onSelectSession}
							onNewSession={props.onNewSession}
						/>
					)}
				</>
			) : (
				<ImConversationList onSelectSession={props.onSelectSession} />
			)}
			<div className="flex items-center gap-1 min-w-0">
				<RecycleBinButton
					onClick={() => setShowTrash(true)}
					count={trashCount}
					compact={width < 240}
				/>
				<SettingsButton
					onClick={() => useSettingsStore.getState().open()}
					compact={width < 240}
				/>
			</div>
			{showTrash && (
				<RecycleBinModal
					onClose={() => {
						setShowTrash(false);
						void refreshBadge();
					}}
				/>
			)}
		</aside>
	);
}
