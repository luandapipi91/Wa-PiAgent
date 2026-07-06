import { useState } from "react";
import type { AgentConfig } from "hiagent-shared";
import { avatarStyle } from "../theme/agents";
import { PartnerPanel } from "./PartnerPanel";

export function AgentConfig({ agent, onClose }: { agent: AgentConfig; onClose: () => void }) {
  const [form, setForm] = useState(agent);
  const [tab, setTab] = useState<"basic" | "prompt" | "tools" | "partners">("basic");

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
      <div className="bg-base rounded-xl w-[720px] max-h-[85vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="bg-mantle px-4 py-3 border-b border-surface flex items-center justify-between">
          <div className="flex items-center gap-3.5">
            <div className="rounded-full flex items-center justify-center text-[26px] border-2 border-text relative"
                 style={{ ...avatarStyle(form.name, 52) }}>
              {form.avatar}
            </div>
            <div>
              <div className="font-semibold text-[15px] text-text">{form.displayName} Agent</div>
              <div className="text-[10px] text-overlay">~/.pi/agent/agents/{form.name}.md · FIFO 串行</div>
            </div>
          </div>
          <div className="flex gap-1.5">
            <button onClick={onClose} className="border border-surface2 text-subtext px-3 py-1.5 rounded text-[11px]">查看原始 .md</button>
            <button onClick={onClose} className="bg-blue text-base px-3 py-1.5 rounded text-[11px] font-semibold">保存</button>
          </div>
        </div>
        {/* Tabs */}
        <div className="bg-mantle flex border-b border-surface text-[11px]">
          {([["basic","基本信息"], ["prompt","系统提示词"], ["tools","工具"], ["partners","合作伙伴"]] as const).map(([k, label]) => (
            <div key={k} onClick={() => setTab(k)} className="px-4 py-2 cursor-pointer"
                 style={tab === k ? { color: "#89b4fa", borderBottom: "2px solid #89b4fa", fontWeight: 600 } : { color: "#6c7086" }}>
              {label}
            </div>
          ))}
        </div>
        {/* 左右布局 */}
        <div className="flex-1 overflow-hidden grid" style={{ gridTemplateColumns: tab === "partners" ? "1fr 320px" : "1fr" }}>
          <div className="p-4 overflow-y-auto border-r border-surface">
            {tab === "basic" && (
              <div className="space-y-3.5 text-sm">
                <div className="grid grid-cols-2 gap-3.5">
                  <Field label="名称 (name)" value={form.name} onChange={v => setForm({ ...form, name: v })} />
                  <Field label="显示名" value={form.displayName} onChange={v => setForm({ ...form, displayName: v })} />
                </div>
                <Field label="描述（决定何时被委派）" value={form.description} onChange={v => setForm({ ...form, description: v })} />
                <div className="grid grid-cols-2 gap-3.5">
                  <Field label="模型" value={form.model} onChange={v => setForm({ ...form, model: v })} />
                  <Field label="thinking level" value={form.thinking} onChange={v => setForm({ ...form, thinking: v as any })} />
                </div>
              </div>
            )}
            {tab === "prompt" && (
              <div>
                <div className="text-overlay text-[10px] mb-1.5">系统提示词</div>
                <textarea className="w-full bg-mantle border border-surface rounded-md p-2.5 text-[11px] text-subtext font-mono h-64 outline-none"
                  value={form.systemPrompt ?? ""} onChange={e => setForm({ ...form, systemPrompt: e.target.value })} />
              </div>
            )}
            {tab === "tools" && (
              <div>
                <div className="text-overlay text-[10px] mb-2">工具（已启用 {form.tools.length} 个）</div>
                <div className="flex flex-wrap gap-1.5">
                  {form.tools.map(t => (
                    <span key={t} className="rounded-xl px-2.5 py-1 text-[11px] cursor-pointer"
                      style={{ background: "rgba(166,227,161,0.15)", border: "1px solid #a6e3a1", color: "#a6e3a1" }}>✓ {t}</span>
                  ))}
                  <span className="rounded-xl px-2.5 py-1 text-[11px]"
                    style={{ background: "rgba(137,180,250,0.15)", border: "1px solid #89b4fa", color: "#89b4fa" }}>✓ intercom</span>
                </div>
                <div className="text-overlay text-[10px] mt-4 italic">MVP：工具编辑需 kernel 加 agent:save-config 命令（后续迭代）</div>
              </div>
            )}
            {tab === "partners" && <div className="text-overlay text-[11px] p-4">合作伙伴配置见右侧面板 →</div>}
          </div>
          {tab === "partners" && <PartnerPanel config={form} />}
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <div className="text-overlay text-[10px] mb-1">{label}</div>
      <input className="w-full bg-surface border border-surface2 text-text px-2.5 py-1.5 rounded text-[12px] outline-none"
        value={value} onChange={e => onChange(e.target.value)} />
    </div>
  );
}
