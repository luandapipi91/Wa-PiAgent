import { useState } from "react";
import { useAgents } from "../store/agents";
import { useSession } from "../store/session";
import { useIntercom } from "../store/intercom";
import { avatarStyle } from "../theme/agents";
import type { AgentConfig } from "hiagent-shared";
import { AgentConfig as AgentConfigModal } from "./AgentConfig";

function IntercomStatusBar() {
  const unresolved = useIntercom(s => s.asks.filter(a => !a.resolved));
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

export function Sidebar() {
  const list = useAgents(s => s.list);
  const states = useAgents(s => s.states);
  const currentAgent = useSession(s => s.currentAgent);
  const selectAgent = useSession(s => s.selectAgent);
  const [editing, setEditing] = useState<AgentConfig | null>(null);

  return (
    <div className="w-[260px] bg-mantle border-r border-surface flex flex-col">
      <div className="p-2.5 border-b border-surface">
        <div className="bg-surface border border-dashed border-surface2 rounded-md py-2 text-center text-overlay text-[11px] cursor-pointer">+ 新会话</div>
      </div>
      <div className="p-2.5 border-b border-surface">
        <div className="text-overlay text-[9px] font-semibold mb-2 uppercase tracking-wider">角色</div>
        <div className="flex flex-col gap-1">
          {list.map(a => {
            const st = states[a.name]?.status ?? "idle";
            const isCurrent = currentAgent === a.name;
            const dotColor = st === "thinking" ? "#89b4fa" : st === "blocked" ? "#fab387" : "transparent";
            return (
              <div key={a.name} onClick={() => selectAgent(a.name)} onDoubleClick={() => setEditing(a)}
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
      <div className="p-2.5 flex-1 overflow-y-auto">
        <div className="text-overlay text-[9px] font-semibold mb-2 uppercase tracking-wider">会话历史</div>
        <div className="text-overlay text-[10px] italic">（MVP：历史功能后续迭代）</div>
      </div>
      <IntercomStatusBar />
      {editing && <AgentConfigModal agent={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}
