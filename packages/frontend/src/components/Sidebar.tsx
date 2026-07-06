import { useState } from "react";
import { useAgents } from "../store/agents";
import { useSession, type SessionItem } from "../store/session";
import { useIntercom } from "../store/intercom";
import { avatarStyle } from "../theme/agents";
import type { AgentConfig } from "hiagent-shared";
import { AgentConfig as AgentConfigModal } from "./AgentConfig";

function IntercomStatusBar() {
  const asks = useIntercom(s => s.asks);
  const unresolved = asks.filter(a => !a.resolved);
  if (unresolved.length === 0) return null;
  return (
    <div className="p-2 px-2.5 border-t border-surface flex gap-4 overflow-x-auto" style={{ background: "rgba(250,179,135,0.06)" }}>
      {unresolved.map(a => (
        <span key={a.messageId} className="text-[9px] text-peach whitespace-nowrap">
          ● {a.from}→{a.to}: {a.text.slice(0, 20)}...
        </span>
      ))}
    </div>
  );
}

function SessionRow({ item, isCurrent, onClick }: { item: SessionItem; isCurrent: boolean; onClick: () => void }) {
  const time = new Date(item.lastActivity).toLocaleTimeString().slice(0, 5);
  return (
    <div
      onClick={onClick}
      className="py-2 px-2.5 rounded flex items-center gap-2.5 cursor-pointer transition"
      style={isCurrent ? { background: "rgba(137,180,250,0.1)" } : {}}
    >
      <div style={avatarStyle(item.agentName, 24)}>{item.avatar}</div>
      <div className="flex-1 min-w-0">
        <div className="text-[11px] font-semibold text-text truncate">{item.displayName} · {time}</div>
        <div className="text-[10px] text-overlay truncate">{item.lastMessage || "新会话"}</div>
      </div>
    </div>
  );
}

export function Sidebar() {
  const list = useAgents(s => s.list);
  const states = useAgents(s => s.states);
  const currentAgent = useSession(s => s.currentAgent);
  const selectAgent = useSession(s => s.selectAgent);
  const sessions = useSession(s => s.sessions);
  const [editing, setEditing] = useState<AgentConfig | null>(null);

  const handleSelectAgent = (name: string) => {
    const agent = list.find(a => a.name === name);
    selectAgent(name, agent?.displayName, agent?.avatar);
  };

  return (
    <div className="w-[260px] bg-mantle border-r border-surface flex flex-col h-full">
      <div className="p-2.5 border-b border-surface">
        <div
          className="bg-surface border border-dashed border-surface2 rounded-md py-2 text-center text-overlay text-[11px] cursor-pointer hover:border-blue/50 transition"
          onClick={() => selectAgent("")}
        >
          + 新会话
        </div>
      </div>

      {/* 角色区 */}
      <div className="p-2.5 border-b border-surface">
        <div className="text-overlay text-[9px] font-semibold mb-2 uppercase tracking-wider">角色</div>
        <div className="flex flex-col gap-1">
          {list.map(a => {
            const st = states[a.name]?.status ?? "idle";
            const isCurrent = currentAgent === a.name;
            const dotColor = st === "thinking" ? "#89b4fa" : st === "blocked" ? "#fab387" : "transparent";
            return (
              <div key={a.name} onClick={() => handleSelectAgent(a.name)} onDoubleClick={() => setEditing(a)}
                className="py-1.5 px-2 rounded flex items-center gap-2 cursor-pointer"
                style={isCurrent ? { background: "rgba(137,180,250,0.15)", borderLeft: "2px solid #89b4fa" } : {}}>
                <div style={avatarStyle(a.name, 22)}>{a.avatar}</div>
                <div className={"text-[11px] font-semibold flex-1 " + (isCurrent ? "text-blue" : "text-text")}>{a.displayName}</div>
                {isCurrent && <span className="bg-green/20 text-green text-[8px] px-[5px] py-px rounded-md">当前</span>}
                {!isCurrent && st !== "idle" && <span className="text-[8px]" style={{ color: dotColor }}>●</span>}
              </div>
            );
          })}
        </div>
      </div>

      {/* 会话历史区 */}
      <div className="flex-1 overflow-y-auto p-2.5">
        <div className="text-overlay text-[9px] font-semibold mb-2 uppercase tracking-wider">会话历史</div>
        {sessions.length === 0 && (
          <div className="text-overlay text-[10px] italic">暂无会话，点击角色开始对话</div>
        )}
        <div className="flex flex-col gap-0.5">
          {sessions.map(s => (
            <SessionRow
              key={s.agentName}
              item={s}
              isCurrent={currentAgent === s.agentName}
              onClick={() => selectAgent(s.agentName, s.displayName, s.avatar)}
            />
          ))}
        </div>
      </div>

      <IntercomStatusBar />
      {editing && <AgentConfigModal agent={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
