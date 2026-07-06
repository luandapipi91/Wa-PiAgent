import { useEffect, useState } from "react";
import { useAgents } from "../store/agents";
import { useSession } from "../store/session";
import { wsClient } from "../ws-instance";
import { AGENT_THEME } from "../theme/agents";
import type { AgentConfig } from "hiagent-shared";

function RoleCard({ agent, selected, onClick }: { agent: AgentConfig; selected: boolean; onClick: () => void }) {
  const [from, to] = AGENT_THEME[agent.name]?.gradient ?? ["#6c7086", "#585b70"];
  return (
    <div
      onClick={onClick}
      className="text-center cursor-pointer rounded-xl p-[14px_18px] min-w-[100px] border-2 transition"
      style={selected
        ? { borderColor: "#89b4fa", background: "rgba(137,180,250,0.15)", boxShadow: "0 0 20px rgba(137,180,250,0.2)" }
        : { borderColor: "transparent", background: "#313244" }}
    >
      <div className="w-11 h-11 rounded-full mx-auto mb-1.5 flex items-center justify-center text-[22px]"
           style={{ background: `linear-gradient(135deg, ${from}, ${to})` }}>
        {agent.avatar}
      </div>
      <div className="font-semibold text-[12px]" style={{ color: selected ? "#89b4fa" : "#cdd6f4" }}>
        {agent.displayName}
      </div>
      <div className="text-[9px] text-overlay mt-0.5">{AGENT_THEME[agent.name]?.subtitle ?? agent.description}</div>
    </div>
  );
}

export function LaunchScreen() {
  const list = useAgents(s => s.list);
  const setList = useAgents(s => s.setList);
  const selectAgent = useSession(s => s.selectAgent);
  const [selected, setSelected] = useState<string | null>(null);
  const [text, setText] = useState("");

  useEffect(() => {
    wsClient.send({ type: "agents:list" });
    const off = wsClient.onEvent(e => { if (e.type === "agents:list") setList(e.agents); });
    return off;
  }, [setList]);

  const send = () => {
    if (!selected || !text.trim()) return;
    const agent = list.find(a => a.name === selected);
    selectAgent(selected, agent?.displayName, agent?.avatar);
    setText("");
  };

  return (
    <div className="h-screen flex flex-col">
      <div className="bg-mantle px-4 py-2 flex items-center justify-between border-b border-surface">
        <span className="font-semibold text-blue">HiAgent</span>
        <div className="flex gap-2.5">
          {["🗂 历史", "🧩 插件", "⚙ 设置"].map(t =>
            <span key={t} className="bg-surface px-2.5 py-[3px] rounded text-[10px] text-overlay cursor-pointer">{t}</span>
          )}
        </div>
      </div>
      <div className="flex-1 flex flex-col items-center justify-center p-10">
        <div className="text-[28px] font-bold text-text mb-2">开始新会话</div>
        <div className="text-overlay text-[13px] mb-8">选择一个角色，告诉它你要做什么</div>
        <div className="flex gap-3 mb-6">
          {list.map(a => (
            <RoleCard key={a.name} agent={a} selected={selected === a.name} onClick={() => setSelected(a.name)} />
          ))}
          {list.length === 0 && <div className="text-overlay">加载中...（确认内核已启动）</div>}
        </div>
        <div className="w-full max-w-[640px] bg-surface border border-surface2 rounded-xl p-[14px_16px]">
          <div className="flex items-start gap-2.5">
            {selected && <span className="text-blue text-[14px]">{list.find(a => a.name === selected)?.avatar}</span>}
            <input
              className="bg-transparent border-none text-text flex-1 text-[13px] outline-none"
              placeholder={selected ? `给${list.find(a => a.name === selected)?.displayName}描述你的需求，或 /命令...` : "先选择一个角色..."}
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            />
          </div>
          <div className="flex justify-between items-center mt-2.5">
            <div className="flex gap-1.5">
              <span className="bg-base px-2 py-[3px] rounded text-[10px] text-overlay cursor-pointer">📎 附件</span>
              <span className="bg-base px-2 py-[3px] rounded text-[10px] text-overlay cursor-pointer">🎨 模型</span>
            </div>
            <button onClick={send} disabled={!selected || !text.trim()}
              className="bg-blue text-base px-3.5 py-[5px] rounded-md text-[11px] font-semibold disabled:opacity-50">
              发送 →
            </button>
          </div>
        </div>
        <div className="mt-4 text-overlay text-[10px] text-center">
          💡 选好角色后直接打字发送即可开始。会话中 agent 可通过 intercom 委派给其他角色。
        </div>
      </div>
    </div>
  );
}
