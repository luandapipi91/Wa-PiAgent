import { useEffect, useState } from "react";
import type { AgentConfig, AgentName } from "@hiagent/shared";
import { AGENT_DEFS } from "@hiagent/shared";
import { useAgentsStore } from "../store/agents";
import { send, onMessage } from "../ws-instance";

interface Props { agentName: AgentName; onClose: () => void; }

type Tab = "basic" | "prompt" | "tools" | "skills" | "partners" | "capabilities";

export function AgentConfig({ agentName, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("basic");
  const [draft, setDraft] = useState<AgentConfig | null>(null);
  const config = useAgentsStore(s => s.configs[agentName]);

  useEffect(() => {
    useAgentsStore.getState().loadConfig(agentName);
    const off = onMessage(e => {
      if (e.type === "agent:config" && e.agentName === agentName) {
        setDraft(e.config);
      }
    });
    return off;
  }, [agentName]);

  useEffect(() => { if (config && !draft) setDraft(config); }, [config, draft]);

  const save = () => {
    if (draft) send({ type: "agent:config:save", agentName, config: draft });
    onClose();
  };

  const tabs: Tab[] = ["basic", "prompt", "tools", "skills", "partners", "capabilities"];

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50" style={{ background: "rgba(0,0,0,0.5)" }} data-testid="agent-config">
      <div className="rounded-lg w-[800px] h-[600px] flex flex-col" style={{ background: "#1e1e2e" }}>
        <header className="flex items-center gap-3 p-4 border-b border-surface2">
          <div className="w-10 h-10 rounded-full flex items-center justify-center text-xl" style={{ background: `linear-gradient(135deg, ${AGENT_DEFS[agentName].gradient[0]}, ${AGENT_DEFS[agentName].gradient[1]})` }}>
            {AGENT_DEFS[agentName].emoji}
          </div>
          <div className="flex-1">
            <div className="text-text font-semibold">{draft?.displayName ?? agentName}</div>
            <div className="text-xs text-overlay">{AGENT_DEFS[agentName].label}</div>
          </div>
          <button onClick={save} className="px-3 py-1 rounded text-sm" style={{ background: "#89b4fa", color: "#1e1e2e" }}>保存</button>
          <button onClick={onClose} className="text-overlay hover:text-text">✕</button>
        </header>
        <nav className="flex gap-1 px-4 border-b border-surface2">
          {tabs.map(t => (
            <button key={t} onClick={() => setTab(t)} className="px-3 py-2 text-sm" style={{ borderBottom: tab === t ? "2px solid #89b4fa" : "none", color: tab === t ? "#cdd6f4" : "#6c7086" }}>
              {t === "basic" ? "基本信息" : t === "prompt" ? "系统提示词" : t === "tools" ? "工具" : t === "skills" ? "技能" : t === "partners" ? "合作伙伴" : "能力"}
            </button>
          ))}
        </nav>
        <div className="flex-1 p-4 overflow-auto text-text" data-testid="config-tab-content">
          {!draft && <p className="text-overlay">加载中...</p>}
          {draft && tab === "basic" && <BasicTab draft={draft} onChange={setDraft} />}
          {draft && tab === "prompt" && <PromptTab draft={draft} onChange={setDraft} />}
          {draft && tab === "partners" && <PartnersTab draft={draft} onChange={setDraft} />}
          {draft && (tab === "tools" || tab === "skills" || tab === "capabilities") && (
            <p className="text-overlay">{tab} 内容（工具/技能以逗号分隔编辑，MVP 简化）</p>
          )}
        </div>
      </div>
    </div>
  );
}

function BasicTab({ draft, onChange }: { draft: AgentConfig; onChange: (c: AgentConfig) => void }) {
  return (
    <div className="flex flex-col gap-3">
      <label className="flex gap-2 items-center"><span className="w-20 text-subtext">显示名</span>
        <input value={draft.displayName} onChange={e => onChange({ ...draft, displayName: e.target.value })} className="flex-1 bg-mantle rounded px-2 py-1 text-sm" /></label>
      <label className="flex gap-2 items-center"><span className="w-20 text-subtext">描述</span>
        <input value={draft.description} onChange={e => onChange({ ...draft, description: e.target.value })} className="flex-1 bg-mantle rounded px-2 py-1 text-sm" /></label>
      <label className="flex gap-2 items-center"><span className="w-20 text-subtext">模型</span>
        <input value={draft.model} onChange={e => onChange({ ...draft, model: e.target.value })} className="flex-1 bg-mantle rounded px-2 py-1 text-sm" /></label>
      <label className="flex gap-2 items-center"><span className="w-20 text-subtext">thinking</span>
        <select value={draft.thinking} onChange={e => onChange({ ...draft, thinking: e.target.value as AgentConfig["thinking"] })} className="bg-mantle rounded px-2 py-1 text-sm">
          <option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
        </select></label>
    </div>
  );
}

function PromptTab({ draft, onChange }: { draft: AgentConfig; onChange: (c: AgentConfig) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-subtext text-sm">系统提示词正文（frontmatter 之后）</span>
      <textarea value={draft.systemPromptBody ?? ""} onChange={e => onChange({ ...draft, systemPromptBody: e.target.value })} className="bg-mantle rounded p-2 text-sm font-mono" rows={15} />
      <span className="text-xs text-overlay">模式：{draft.systemPromptMode}</span>
    </div>
  );
}

function PartnersTab({ draft, onChange }: { draft: AgentConfig; onChange: (c: AgentConfig) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-peach text-sm">↗ 可发起 ask 给（出向）</span>
      <input value={draft.partners.askTo.join(", ")} onChange={e => onChange({ ...draft, partners: { ...draft.partners, askTo: e.target.value.split(",").map(s => s.trim()).filter(Boolean) as AgentName[] } })} className="bg-mantle rounded px-2 py-1 text-sm" />
      <span className="text-green text-sm mt-2">↙ 可被 ask 自（入向）</span>
      <input value={draft.partners.askFrom.join(", ")} onChange={e => onChange({ ...draft, partners: { ...draft.partners, askFrom: e.target.value.split(",").map(s => s.trim()).filter(Boolean) as AgentName[] } })} className="bg-mantle rounded px-2 py-1 text-sm" />
    </div>
  );
}
