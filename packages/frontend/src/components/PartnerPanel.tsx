import type { AgentConfig } from "hiagent-shared";
import { useAgents } from "../store/agents";
import { avatarStyle } from "../theme/agents";

export function PartnerPanel({ config }: { config: AgentConfig }) {
  const allAgents = useAgents(s => s.list);
  const outbound = allAgents.filter(a => config.partners.askTo.includes(a.name));
  const inbound = allAgents.filter(a => config.partners.askFrom.includes(a.name));

  const PartnerRow = ({ a, label }: { a: AgentConfig; label: string }) => (
    <div className="bg-surface rounded-lg p-2.5 flex items-center gap-2.5">
      <div style={avatarStyle(a.name, 36)}>{a.avatar}</div>
      <div className="flex-1">
        <div className="font-semibold text-[12px] text-text">{a.displayName}</div>
        <div className="text-[10px] text-overlay">{label}</div>
      </div>
      <span className="text-green text-[16px] cursor-pointer">✓</span>
    </div>
  );

  return (
    <div className="bg-mantle p-4 overflow-y-auto">
      <div className="text-blue text-[12px] font-semibold mb-1">🤝 合作伙伴</div>
      <div className="text-overlay text-[10px] mb-4">定义{config.displayName}可向谁发起 ask，以及谁能 ask {config.displayName}</div>

      <div className="text-peach text-[11px] font-semibold mb-2">↗ 可发起 ask 给（出向）</div>
      <div className="flex flex-col gap-2 mb-4">
        {outbound.map(a => <PartnerRow key={a.name} a={a} label={a.description} />)}
        <div className="border border-dashed border-surface2 rounded-lg p-2.5 flex items-center gap-2.5 opacity-60 cursor-pointer">
          <div className="w-9 h-9 rounded-full bg-surface flex items-center justify-center text-overlay">＋</div>
          <div className="text-[11px] text-overlay">添加伙伴...</div>
        </div>
      </div>

      <div className="text-green text-[11px] font-semibold mb-2">↙ 可被 ask 自（入向）</div>
      <div className="flex flex-col gap-2">
        {inbound.map(a => <PartnerRow key={a.name} a={a} label={a.description} />)}
      </div>

      <div className="grid grid-cols-2 gap-2 mt-3.5 text-[10px]">
        <div className="bg-surface p-2 rounded-md text-center">
          <div className="text-peach font-bold text-[16px]">{outbound.length}</div>
          <div className="text-overlay">出向伙伴</div>
        </div>
        <div className="bg-surface p-2 rounded-md text-center">
          <div className="text-green font-bold text-[16px]">{inbound.length}</div>
          <div className="text-overlay">入向伙伴</div>
        </div>
      </div>
    </div>
  );
}
