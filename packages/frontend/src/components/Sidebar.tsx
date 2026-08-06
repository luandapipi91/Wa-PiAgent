import { useState } from "react";
import type { View } from "../App";
import { NewSessionButton } from "./NewSessionButton";
import { AgentListSection } from "./AgentListSection";
import { ProjectList } from "./ProjectList";
import { SettingsButton } from "./SettingsButton";
import { ImConversationList } from "./ImConversationList";
import { useSettingsStore } from "../store/settings";
import { useSidebarStore } from "../store/sidebar";

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
  // 侧边栏页签：任务（默认）| IM。切换只切换内容区，SettingsButton 始终可见。
  const [tab, setTab] = useState<"tasks" | "im">("tasks");
  return (
    <aside
      className="flex flex-col gap-1.5 p-3.5 overflow-hidden border-r border-hairline"
      style={{ width, background: "var(--surface-elevated)" }}
      data-testid="sidebar"
    >
      <div className="flex items-center gap-2 px-2 pb-2.5">
        <img src="/logo.svg" alt="WA PI Agent" className="w-7 h-7" style={{ borderRadius: 7 }} />
        <span className="font-extrabold text-[calc(17px*var(--font-scale))] tracking-tight text-primary">WA PI Agent</span>
      </div>
      {/* 任务 | IM 分段控件 */}
      <div className="flex rounded-md p-0.5" style={{ background: "var(--surface-hover)" }}>
        {(["tasks", "im"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className="flex-1 text-xs font-medium py-1 rounded-sm border-0 cursor-pointer"
            style={tab === t
              ? { background: "var(--surface)", color: "var(--text-primary)", boxShadow: "var(--shadow-sm)" }
              : { background: "transparent", color: "var(--text-secondary)" }}
            data-testid={t === "tasks" ? "sidebar-tab-tasks" : "sidebar-tab-im"}
          >{t === "tasks" ? "任务" : "IM"}</button>
        ))}
      </div>
      {tab === "tasks" ? (
        <>
          <NewSessionButton onNewSession={props.onNewSession} />
          <AgentListSection onChatWith={props.onChatWith} onEdit={props.onEdit} onMore={props.onMore} />

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
      <SettingsButton onClick={() => useSettingsStore.getState().open()} />
    </aside>
  );
}
