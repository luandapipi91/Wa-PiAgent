import { useState, useEffect } from "react";
import type { View } from "../App";
import { NewSessionButton } from "./NewSessionButton";
import { AgentListSection } from "./AgentListSection";
import { ProjectList } from "./ProjectList";
import { SettingsButton } from "./SettingsButton";
import { RecycleBinButton } from "./RecycleBinButton";
import { RecycleBinModal } from "./RecycleBinModal";
import { ImConversationList } from "./ImConversationList";
import { useSettingsStore } from "../store/settings";
import { useSidebarStore } from "../store/sidebar";
import { useTrashStore } from "../store/trash";
import { useTranslation } from "../i18n/useTranslation";

interface Props {
	onNewSession: () => void;
	onChatWith: (name: string) => void;
	onEdit: (name: string) => void;
	onMore: () => void;
	onSelectSession: (id: string) => void;
	onNewSessionInProject: (projectId: string) => void;
	onSelectProject: (projectId: string) => void;
	onNewProject: () => void;
	currentView?: View;
}

export function Sidebar(props: Props) {
	const width = useSidebarStore((s) => s.width);
	const { t } = useTranslation();
	// 侧边栏页签：任务（默认）| IM。切换只切换内容区，SettingsButton 始终可见。
	const [tab, setTab] = useState<"tasks" | "im">("tasks");
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
			<div className="flex items-center gap-2 px-2 pb-2.5">
				<img
					src="/logo.svg"
					alt="WA PI Agent"
					className="w-[38px] h-[38px]"
					style={{ borderRadius: 9.5 }}
				/>
				<span className="font-extrabold text-[calc(18px*var(--font-scale))] tracking-tight text-primary">
					WA PI Agent
				</span>
			</div>
			{/* 任务 | IM 分段控件 */}
			<div
				className="flex rounded-md p-0.5"
				style={{ background: "var(--surface-hover)" }}
			>
				{(["tasks", "im"] as const).map((tabKey) => (
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
						data-testid={
							tabKey === "tasks" ? "sidebar-tab-tasks" : "sidebar-tab-im"
						}
					>
						{tabKey === "tasks" ? t("sidebar.tabTasks") : t("sidebar.tabIm")}
					</button>
				))}
			</div>
			{tab === "tasks" ? (
				<>
					<NewSessionButton onNewSession={props.onNewSession} />
					<AgentListSection
						onChatWith={props.onChatWith}
						onEdit={props.onEdit}
						onMore={props.onMore}
					/>

					{/* 默认工作区已合并到 ProjectList 顶部，与普通项目共用同一滚动容器 */}
					<ProjectList
						onSelectSession={props.onSelectSession}
						onNewSessionInProject={props.onNewSessionInProject}
						onSelectProject={props.onSelectProject}
						onNewProject={props.onNewProject}
						currentView={props.currentView}
					/>
				</>
			) : (
				<ImConversationList onSelectSession={props.onSelectSession} />
			)}
			<div className="flex items-center gap-1">
				<RecycleBinButton
					onClick={() => setShowTrash(true)}
					count={trashCount}
				/>
				<SettingsButton onClick={() => useSettingsStore.getState().open()} />
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
