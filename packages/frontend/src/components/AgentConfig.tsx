import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AgentConfig, AgentName, AgentToolItem } from "@wa-pi/shared";
import { agentDefOf, slugifyProviderName, isSubagentType } from "@wa-pi/shared";
import { useAgentsStore } from "../store/agents";
import { useSkillsStore } from "../store/skills";
import { useProvidersStore } from "../store/providers";
import { useSubagentsStore } from "../store/subagents";
import { api } from "../api-client";
import { onMessage } from "../events";
import type { SubagentOverride } from "@wa-pi/shared";
import { Modal } from "./ui/Modal";
import { filterItems } from "../quick-invoke/trigger";

interface Props { agentName: AgentName; onClose: () => void; }

type Tab = "basic" | "tools" | "skills" | "partners";

const TABS: { key: Tab; label: string }[] = [
  { key: "basic", label: "基本" },
  { key: "tools", label: "工具" },
  { key: "skills", label: "技能" },
  { key: "partners", label: "关系网" },
];

const inp = "flex-1 px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none placeholder:text-tertiary";

interface TabProps { draft: AgentConfig; onChange: (c: AgentConfig) => void; }

export function AgentConfig({ agentName, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("basic");
  const [draft, setDraft] = useState<AgentConfig | null>(null);
  const [tools, setTools] = useState<AgentToolItem[]>([]);
  const config = useAgentsStore(s => s.configs[agentName]);
  // model 有效性校验：磁盘残留的裸 ID（如 glm-4.6）不匹配 select option（slug/id 格式），视为无效
  const providers = useProvidersStore(s => s.providers);
  const modelIds = useMemo(() => {
    const slugs: string[] = [];
    const ids = new Set<string>();
    for (const p of providers) {
      const slug = slugifyProviderName(p.name, slugs);
      slugs.push(slug);
      for (const m of p.models) ids.add(`${slug}/${m.id}`);
    }
    return ids;
  }, [providers]);

  // 内置 subagent（general-purpose / Explore / Plan）：不在 agents store 里，
  // 用 useSubagentsStore 获取真实 systemPrompt + builtinToolNames（来自 pi-subagents）。
  const isBuiltin = isSubagentType(agentName);
  const builtinInfo = useSubagentsStore(s => s.subagents.find(i => i.name === agentName));
  const builtinDraft: AgentConfig | null = useMemo(() => {
    if (!builtinInfo) return null;
    return {
      displayName: builtinInfo.displayName,
      avatar: builtinInfo.emoji,
      avatarColor: `${builtinInfo.gradient[0]}-${builtinInfo.gradient[1]}`,
      description: builtinInfo.description,
      // model/thinking 来自用户 override（无 override 时 null = 跟随主智能体）
      model: builtinInfo.override?.model ?? null,
      thinking: builtinInfo.override?.thinking ?? null,
      // 工具：内置 subagent 的真实 builtinToolNames，只读展示
      tools: builtinInfo.builtinToolNames ?? [],
      skills: [],
      mcpServers: [],
      partners: { askTo: [] },
      delegationHints: builtinInfo.delegationHints,
      // 真实 systemPrompt（来自 pi-subagents），只读展示
      systemPromptBody: builtinInfo.systemPrompt,
    };
  }, [builtinInfo]);

  useEffect(() => {
    // 内置 subagent 不走 WS 加载，直接用本地构造的 draft
    if (isBuiltin) {
      if (builtinDraft) setDraft(builtinDraft);
      return;
    }
    // 先从 store 缓存设置初始值（如果已有），然后通过 API 拉取最新数据覆盖
    useAgentsStore.getState().loadConfig(agentName);
    // 强制 API 重新加载，覆盖可能过期的 store 缓存（修复关闭重开后显示旧数据）
    api.get(`/api/agents/${encodeURIComponent(agentName)}/config`).then((data: any) => {
      if (data?.config) {
        useAgentsStore.getState().setConfig(agentName, data.config);
        setDraft(data.config);
      }
    }).catch(() => {});
    api.get("/api/agents/tools").then((data: any) => { if (data?.tools) setTools(data.tools); });
    const off = onMessage(e => {
      if (e.type === "agent:config" && e.agentName === agentName) setDraft(e.config);
      if (e.type === "agent:tools:list") setTools(e.tools);
    });
    return off;
  }, [agentName, isBuiltin, builtinDraft]);

  const allAgents = useAgentsStore(s => s.list);

  useEffect(() => { if (config && !draft && !isBuiltin) setDraft(config); }, [config, draft, isBuiltin]);

  // 重名校验：displayName 与其他智能体重复（自身原名除外）；空名也禁保存
  const trimmedName = draft?.displayName?.trim() ?? "";
  const nameConflict = trimmedName !== "" && trimmedName !== agentName &&
    allAgents.some(a => a.displayName === trimmedName);
  const nameEmpty = trimmedName === "";

  const canSave = !!draft && (isBuiltin || (!nameEmpty && !nameConflict));

  const handleChange = (next: AgentConfig) => {
    setDraft(next);
  };

  const save = () => {
    if (!draft) return;
    if (isBuiltin) {
      const validModel = modelIds.size > 0 && draft.model && !modelIds.has(draft.model) ? null : draft.model;
      const override: SubagentOverride = {
        type: agentName,
        model: validModel ?? null,
        thinking: draft.thinking ?? null,
      };
      useSubagentsStore.getState().saveOverride(override);
      onClose();
      return;
    }
    if (!canSave) return;
    // model 无效（磁盘残留裸 ID 不匹配 option）时置 null（跟随全局），避免"显示跟随全局但保存旧值"
    const configToSend = modelIds.size > 0 && draft.model && !modelIds.has(draft.model)
      ? { ...draft, model: null }
      : draft;
    // 名称可能被改：agentName 为旧 displayName，draft.displayName 为新值，kernel 走 rename 联动
    void api.put(`/api/agents/${encodeURIComponent(agentName)}/config`, { config: configToSend });
    onClose();
  };

  const def = agentDefOf(agentName);
  const [hg1, hg2] = draft?.avatarColor?.includes("-") ? draft.avatarColor.split("-") : def.gradient;

  return (
    <Modal onClose={onClose} width="80vw" height="80vh" closeOnOverlayClick={false} data-testid="agent-config">
      <header className="flex items-center gap-3 px-5 py-3.5 border-b border-hairline">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center text-lg shrink-0"
          style={{ background: `linear-gradient(135deg, ${hg1}, ${hg2})` }}>
          {draft?.avatar || def.emoji}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-primary truncate">{draft?.displayName ?? agentName}</div>
        </div>
      </header>
      <nav className="flex gap-1 px-4 pt-2 border-b border-hairline">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} data-testid={`tab-${t.key}`}
            className={`px-3 py-1.5 text-xs rounded-t-sm transition-colors ${tab === t.key ? "text-primary font-semibold bg-surface-hover" : "text-tertiary hover:text-secondary"}`}>
            {t.label}
          </button>
        ))}
      </nav>
      <div
        className={`px-5 py-4 flex-1 min-h-0 overflow-y-auto ${isBuiltin ? "opacity-60 [&_input[type=checkbox]]:pointer-events-none [&_button]:pointer-events-none [&_textarea]:pointer-events-none" : ""}`}
        data-testid="config-tab-content"
      >
        {!draft && <p className="text-sm text-tertiary">加载中...</p>}
        {/* 内置 subagent：所有字段只读，onChange 用 noop 防止编辑 */}
        {draft && tab === "basic" && <BasicTab draft={draft} onChange={handleChange} />}
        {draft && tab === "tools" && <ToolsTab draft={draft} onChange={handleChange} tools={tools} />}
        {draft && tab === "skills" && <SkillsTab draft={draft} onChange={handleChange} />}
        {draft && tab === "partners" && <PartnersTab draft={draft} onChange={handleChange} selfName={agentName} />}
      </div>
      <footer className="flex justify-end gap-2 px-5 py-3 border-t border-hairline">
        {isBuiltin && (
          <span data-testid="cfg-builtin-notice" className="text-[11px] text-tertiary self-center mr-auto">
            内置 subagent，仅 model / 思考强度可设置
          </span>
        )}
        {!isBuiltin && nameConflict && (
          <span data-testid="cfg-name-error" className="text-[11px] text-danger self-center mr-auto">
            名称「{trimmedName}」已被占用
          </span>
        )}
        <button onClick={onClose}
          className="px-3 py-1.5 rounded-sm text-xs bg-surface-hover text-secondary border border-hairline transition-colors hover:text-primary">关闭</button>
        <button onClick={save} disabled={!canSave} data-testid="cfg-save"
          className="px-3 py-1.5 rounded-sm text-xs border-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          style={{ background: "var(--accent)", color: "#fff" }}>保存</button>
      </footer>
    </Modal>
  );
}

function Sec({ children }: { children: string }) {
  return (
    <div className="flex items-center gap-2 mt-4 first:mt-0 mb-2">
      <span className="text-[11px] tracking-wide text-tertiary uppercase">{children}</span>
      <span className="flex-1 h-px bg-hairline" />
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex items-center gap-2 mb-2">
      <span className="w-12 shrink-0 text-xs text-secondary">{label}</span>
      {children}
    </label>
  );
}

function BasicTab({ draft, onChange }: TabProps) {
  // 模型下拉：扁平化 providers（同 ModelSelector），slug/id 作为 option value
  const providers = useProvidersStore(s => s.providers);
  const models = useMemo(() => {
    const slugs: string[] = [];
    return providers.flatMap(p => {
      const slug = slugifyProviderName(p.name, slugs);
      slugs.push(slug);
      return p.models.map(m => ({
        id: m.id,
        providerName: p.name,
        providerSlug: slug,
      }));
    });
  }, [providers]);
  // model option value 集合：draft.model 若不在其中（如磁盘残留的裸 ID），select 视为未选中（跟随全局）
  const modelIds = useMemo(() => new Set(models.map(m => `${m.providerSlug}/${m.id}`)), [models]);
  const effectiveModel = draft.model && modelIds.has(draft.model) ? draft.model : "";

  return (
    <div>
      <Sec>身份</Sec>
      <Row label="名称">
        <input value={draft.displayName} onChange={e => onChange({ ...draft, displayName: e.target.value })} className={inp} data-testid="cfg-name-input" />
      </Row>
      <Row label="简介">
        <input value={draft.description} onChange={e => onChange({ ...draft, description: e.target.value })} className={inp} />
      </Row>
      <Row label="头像">
        <input value={draft.avatar} onChange={e => onChange({ ...draft, avatar: e.target.value })}
          className="w-14 px-2 py-1.5 rounded-sm border border-hairline bg-surface text-sm text-primary outline-none text-center"
          data-testid="cfg-avatar-input" />
      </Row>

      <Sec>模型</Sec>
      <Row label="模型">
        <select value={effectiveModel} onChange={e => onChange({ ...draft, model: e.target.value || null })}
          className={inp} data-testid="cfg-model-select">
          <option value="">默认（跟随全局）</option>
          {models.map(m => (
            <option key={`${m.providerSlug}/${m.id}`} value={`${m.providerSlug}/${m.id}`}>
              {m.providerName}/{m.id}
            </option>
          ))}
        </select>
      </Row>
      <Row label="思考">
        <select value={draft.thinking ?? ""} onChange={e => onChange({ ...draft, thinking: (e.target.value || null) as AgentConfig["thinking"] })}
          className={inp} data-testid="cfg-thinking-select">
          <option value="">跟随当前</option>
          <option value="disabled">思考 off</option>
          <option value="medium">思考 mid</option>
          <option value="high">思考 high</option>
          <option value="max">思考 max</option>
        </select>
      </Row>

      <Sec>提示词</Sec>
      <textarea value={draft.systemPromptBody ?? ""} onChange={e => onChange({ ...draft, systemPromptBody: e.target.value })}
        className={`${inp} w-full min-h-[300px] resize-y leading-relaxed`} rows={4} />

      <Sec>委派引导</Sec>
      <Row label="何时调起">
        <textarea
          value={draft.delegationHints?.whenToDelegate ?? ""}
          onChange={e => onChange({ ...draft, delegationHints: { ...draft.delegationHints, whenToDelegate: e.target.value } })}
          className={`${inp} w-full min-h-[56px] resize-y leading-relaxed`} rows={2}
          placeholder="什么场景下主智能体应调起本智能体，如：用户描述新需求、需要梳理业务流程"
          data-testid="cfg-hints-when" />
      </Row>
      <Row label="何时不调起">
        <textarea
          value={draft.delegationHints?.whenNotTo ?? ""}
          onChange={e => onChange({ ...draft, delegationHints: { ...draft.delegationHints, whenNotTo: e.target.value } })}
          className={`${inp} w-full min-h-[56px] resize-y leading-relaxed`} rows={2}
          placeholder="什么场景下不该调起，如：已明确到具体代码文件的修改"
          data-testid="cfg-hints-not" />
      </Row>
      <Row label="调起收益">
        <textarea
          value={draft.delegationHints?.benefit ?? ""}
          onChange={e => onChange({ ...draft, delegationHints: { ...draft.delegationHints, benefit: e.target.value } })}
          className={`${inp} w-full min-h-[56px] resize-y leading-relaxed`} rows={2}
          placeholder="调起本智能体的好处，如：把多次 grep 探索的噪声挡在主上下文之外"
          data-testid="cfg-hints-benefit" />
      </Row>

    </div>
  );
}

function ToolsTab({ draft, onChange, tools }: TabProps & { tools: AgentToolItem[] }) {
  const all = tools.map(t => t.name);
  // 防御：draft.tools 可能因磁盘残留/API 兼容性为非数组，统一规范化为 []
  const dtools: string[] = Array.isArray(draft.tools) ? draft.tools : [];
  // 空数组 = 全量默认（kernel 语义）：展示态全部勾选，取消勾选即转为显式列表
  const checked = (n: string) => dtools.length === 0 || dtools.includes(n);
  const toggle = (n: string) => {
    const next = dtools.length === 0
      ? all.filter(x => x !== n)
      : dtools.includes(n) ? dtools.filter(x => x !== n) : [...dtools, n];
    onChange({ ...draft, tools: next });
  };
  if (tools.length === 0) return <p className="text-sm text-tertiary">加载中...</p>;
  return (
    <div className="flex flex-col">
      <p className="text-[11px] text-tertiary mb-2">全部勾选 = 全量默认；取消勾选后按显式列表保存</p>
      {tools.map(t => (
        <label key={t.name} className="flex items-center gap-2 py-1 cursor-pointer justify-between">
          <span className="flex items-center gap-2">
            <span className="text-sm text-primary">{t.name}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full"
              style={{ background: "var(--hairline)", color: "var(--text-tertiary)" }}>{t.source}</span>
          </span>
          <SwitchButton on={checked(t.name)} onClick={() => toggle(t.name)} testId={`tool-switch-${t.name}`} />
        </label>
      ))}
    </div>
  );
}

function SkillsTab({ draft, onChange }: TabProps) {
  const allSkills = useSkillsStore(s => s.allSkills);
  const disabledSkills = useSkillsStore(s => s.disabledSkills);
  const all = allSkills.map(s => s.name);
  // 防御：draft.skills 可能因磁盘残留为非数组，统一规范化为 []
  const skills: string[] = Array.isArray(draft.skills) ? draft.skills : [];
  // 与工具同语义：空数组 = 全量继承，展示态全部勾选
  const checked = (n: string) => skills.length === 0 || skills.includes(n);
  const toggle = (n: string) => {
    const next = skills.length === 0
      ? all.filter(x => x !== n)
      : skills.includes(n) ? skills.filter(x => x !== n) : [...skills, n];
    onChange({ ...draft, skills: next });
  };
  if (allSkills.length === 0) return <p className="text-sm text-tertiary">暂无技能，可在设置中添加技能目录</p>;
  return (
    <div className="flex flex-col">
      <p className="text-[11px] text-tertiary mb-2">全部勾选 = 全量继承；取消勾选后按显式列表保存</p>
      {allSkills.map(s => {
        const globallyDisabled = disabledSkills.includes(s.name);
        return (
        <label key={s.name} data-testid={`skill-row-${s.name}`}
          className="flex items-center gap-2 py-1 cursor-pointer justify-between"
          style={{ opacity: globallyDisabled ? 0.5 : 1 }}>
          <span className="flex items-center gap-2 min-w-0">
            <span className="text-sm text-primary">{s.name}</span>
            <span className="text-[11px] text-tertiary truncate">{s.description}</span>
            {globallyDisabled && (
              <span data-testid={`skill-disabled-label-${s.name}`}
                className="text-[10px] font-semibold" style={{ color: "var(--danger)" }}>全局禁用</span>
            )}
          </span>
          <SwitchButton on={checked(s.name)} onClick={() => toggle(s.name)} testId={`skill-switch-${s.name}`} />
        </label>
        );
      })}
    </div>
  );
}

function PartnersTab({ draft, onChange, selfName }: TabProps & { selfName: string }) {
  const agents = useAgentsStore(s => s.list);
  const [query, setQuery] = useState("");
  const filtered = filterItems(agents.map(a => ({ ...a, name: a.displayName })), query);
  const toggle = (n: string) => {
    const cur = draft.partners.askTo;
    const next = cur.includes(n) ? cur.filter(x => x !== n) : [...cur, n];
    onChange({ ...draft, partners: { ...draft.partners, askTo: next } });
  };
  return (
    <div className="flex flex-col gap-2">
      <input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索智能体"
        className={`${inp} w-full`} data-testid="partner-search" />
      <div className="flex flex-col">
        {filtered.length === 0 && <p className="text-sm text-tertiary py-1">无匹配智能体</p>}
        {filtered.map(a => {
          const isSelf = a.displayName === selfName;
          const checked = !isSelf && draft.partners.askTo.includes(a.displayName);
          return (
            <label key={a.displayName} aria-disabled={isSelf || undefined}
              className={`flex items-center gap-2 py-1 ${isSelf ? "opacity-50" : "cursor-pointer"} justify-between`}>
              <span className="flex items-center gap-2 min-w-0">
                <span className="text-sm text-primary">{a.displayName}</span>
                <span className="text-[11px] text-tertiary truncate">{a.description}</span>
                {isSelf && <span className="text-[10px] text-tertiary shrink-0">自身</span>}
              </span>
              <SwitchButton on={checked} onClick={() => { if (!isSelf) toggle(a.displayName); }} testId={`partner-switch-${a.displayName}`} />
            </label>
          );
        })}
      </div>
      <p className="text-[11px] text-tertiary">勾选本智能体可发起 ask 的对象（askTo）</p>
    </div>
  );
}

/** 内联 Toggle Switch（与插件/技能管理风格一致） */
function SwitchButton({ on, onClick, testId }: { on: boolean; onClick: () => void; testId: string }) {
  return (
    <div
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      className="relative shrink-0 cursor-pointer"
      style={{
        width: 38, height: 22, borderRadius: 9999,
        background: on ? "var(--success)" : "#cbd5e1",
        transition: "background 0.2s",
      }}
      data-testid={testId}
      data-on={on ? "true" : "false"}
    >
      <span
        className="absolute top-0.5 rounded-full bg-white transition-all"
        style={{
          width: 18, height: 18,
          left: on ? undefined : 2,
          right: on ? 2 : undefined,
          boxShadow: "0 1px 2px rgba(0,0,0,.1)",
        }}
      />
    </div>
  );
}
