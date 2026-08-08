import { useEffect, useMemo, useState } from "react";
import type { AgencyPresetMeta } from "@wa-pi/shared";
import { api } from "../../api-client";
import { randomPersonName } from "../../data/name-pool";
import { useAgentsStore } from "../../store/agents";
import { useToastStore } from "../../store/toast";
import { useTranslation } from "../../i18n/useTranslation";

interface Props {
  /** 创建/保存成功回调（向导场景负责设默认并关闭；宫格场景负责刷新） */
  onCreated: (displayName: string) => void;
  /** 宫格场景用于关闭面板；向导场景不传（跳过走向导自己的按钮） */
  onCancel?: () => void;
  autoFocusTab?: "blank" | "preset";
}

type View = { kind: "list" } | { kind: "naming"; preset: AgencyPresetMeta };

/** 取 ApiError 的 HTTP 状态码（直接读字段，避免 instanceof 依赖被 mock 的模块） */
function statusOf(e: unknown): number | undefined {
  return (e as { status?: number })?.status;
}

/** 创建智能体面板：空白创建（随机人名）/ 从预设选择（命名后保存）。向导第 2 步与宫格新建共用。 */
export function AgentCreatePicker({ onCreated, onCancel, autoFocusTab = "blank" }: Props) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"blank" | "preset">(autoFocusTab);
  const agents = useAgentsStore(s => s.list);
  const existingNames = useMemo(() => agents.map(a => a.displayName), [agents]);

  return (
    <div data-testid="agent-create-picker" className="flex flex-col gap-3">
      <div className="flex gap-1 rounded-lg bg-surface-elevated p-1">
        <button data-testid="picker-tab-blank" onClick={() => setTab("blank")}
          className={`flex-1 rounded-md px-3 py-1.5 text-xs ${tab === "blank" ? "bg-accent text-white" : "text-secondary"}`}>
          {t("agentCreatePicker.tabBlank")}
        </button>
        <button data-testid="picker-tab-preset" onClick={() => setTab("preset")}
          className={`flex-1 rounded-md px-3 py-1.5 text-xs ${tab === "preset" ? "bg-accent text-white" : "text-secondary"}`}>
          {t("agentCreatePicker.tabPreset")}
        </button>
      </div>
      {tab === "blank"
        ? <BlankCreate existingNames={existingNames} onCreated={onCreated} />
        : <PresetPick existingNames={existingNames} onCreated={onCreated} />}
      {onCancel && <button onClick={onCancel} className="self-end text-xs text-tertiary">{t("common.cancel")}</button>}
    </div>
  );
}

/** 空白创建：随机人名 + 🎲 + 手改，走 POST /api/agents */
function BlankCreate({ existingNames, onCreated }: { existingNames: string[]; onCreated: (n: string) => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState(() => randomPersonName(existingNames));
  const [saving, setSaving] = useState(false);
  const dup = existingNames.includes(name.trim());
  const valid = name.trim().length > 0 && !dup && !saving;

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    try {
      await api.post("/api/agents", { displayName: name.trim() });
      await useAgentsStore.getState().loadAll();
      onCreated(name.trim());
    } catch (e) {
      useToastStore.getState().add(e instanceof Error ? e.message : String(e), "error");
      // 409 重名：自动换名（排除当前名保证一定换）方便直接重试；其他错误保留手改内容
      if (statusOf(e) === 409) setName(randomPersonName([...existingNames, name.trim()]));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <label className="text-xs text-tertiary">{t("agentCreatePicker.nameLabel")}</label>
      <div className="flex gap-2">
        <input data-testid="blank-name-input" value={name} onChange={e => setName(e.target.value)}
          onKeyDown={e => e.key === "Enter" && void submit()}
          className="flex-1 rounded-md border border-hairline bg-surface px-3 py-2 text-sm text-primary" />
        <button data-testid="blank-reshuffle" title={t("agentCreatePicker.reshuffle")}
          onClick={() => setName(randomPersonName(existingNames))}
          className="rounded-md bg-surface-elevated px-3">🎲</button>
      </div>
      {dup && <div className="text-xs text-danger">{t("agentCreatePicker.nameTaken")}</div>}
      <button data-testid="blank-create-btn" disabled={!valid} onClick={() => void submit()}
        className="rounded-md bg-accent px-3 py-2 text-sm text-white disabled:opacity-40">
        {saving ? t("agentCreatePicker.creating") : t("agentCreatePicker.create")}
      </button>
    </div>
  );
}

/** 预设选择：搜索 + 部门分组 + 命名面板 */
function PresetPick({ existingNames, onCreated }: { existingNames: string[]; onCreated: (n: string) => void }) {
  const { t } = useTranslation();
  const [presets, setPresets] = useState<AgencyPresetMeta[]>([]);
  const [search, setSearch] = useState("");
  const [view, setView] = useState<View>({ kind: "list" });

  useEffect(() => {
    void (async () => {
      try {
        const res = (await api.get("/api/agents/presets")) as { presets?: AgencyPresetMeta[] };
        setPresets(res.presets ?? []);
      } catch (e) {
        useToastStore.getState().add(e instanceof Error ? e.message : String(e), "error");
      }
    })();
  }, []);

  const groups = useMemo(() => {
    const kw = search.trim().toLowerCase();
    const filtered = kw
      ? presets.filter(p => p.name.toLowerCase().includes(kw) || p.description.toLowerCase().includes(kw))
      : presets;
    const map = new Map<string, AgencyPresetMeta[]>();
    for (const p of filtered) {
      const arr = map.get(p.department) ?? [];
      arr.push(p);
      map.set(p.department, arr);
    }
    return Array.from(map.entries());
  }, [presets, search]);

  if (view.kind === "naming") {
    return <NamingPanel preset={view.preset} existingNames={existingNames}
      onBack={() => setView({ kind: "list" })} onCreated={onCreated} />;
  }

  return (
    <div className="flex flex-col gap-2">
      <input data-testid="preset-search-input" value={search} onChange={e => setSearch(e.target.value)}
        placeholder={t("agentCreatePicker.searchPlaceholder", { count: presets.length })}
        className="rounded-md border border-hairline bg-surface px-3 py-2 text-sm text-primary" />
      <div className="flex max-h-[45vh] flex-col gap-3 overflow-auto">
        {groups.map(([dept, list]) => (
          <div key={dept}>
            {/* 计数放子 span：部门名独占直接文本节点，便于按名字断言 */}
            <div className="mb-1 text-xs font-medium text-tertiary">{dept}<span>（{list.length}）</span></div>
            <div className="grid grid-cols-2 gap-2">
              {list.map(p => (
                <button key={p.id} data-testid={`preset-card-${p.id}`}
                  onClick={() => setView({ kind: "naming", preset: p })}
                  className="rounded-lg border border-hairline p-2 text-left hover:border-accent">
                  <div className="text-sm text-primary">{p.emoji} <b>{p.name}</b></div>
                  <div className="mt-0.5 line-clamp-2 text-xs text-tertiary">{p.description}</div>
                </button>
              ))}
            </div>
          </div>
        ))}
        {groups.length === 0 && <div className="py-6 text-center text-xs text-tertiary">{t("agentCreatePicker.noMatch")}</div>}
      </div>
    </div>
  );
}

/** 命名面板：随机人名（🎲/手改）+ 角色能力 + 保存 */
function NamingPanel({ preset, existingNames, onBack, onCreated }: {
  preset: AgencyPresetMeta; existingNames: string[];
  onBack: () => void; onCreated: (n: string) => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(() => randomPersonName(existingNames));
  const [saving, setSaving] = useState(false);
  const dup = existingNames.includes(name.trim());
  const valid = name.trim().length > 0 && !dup && !saving;

  const submit = async () => {
    if (!valid) return;
    setSaving(true);
    try {
      await api.post("/api/agents/from-preset", { id: preset.id, displayName: name.trim() });
      await useAgentsStore.getState().loadAll();
      onCreated(name.trim());
    } catch (e) {
      useToastStore.getState().add(e instanceof Error ? e.message : String(e), "error");
      // 409 重名：自动换名（排除当前名保证一定换）方便直接重试；其他错误保留手改内容
      if (statusOf(e) === 409) setName(randomPersonName([...existingNames, name.trim()]));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="rounded-lg border border-hairline bg-surface-elevated p-3">
        <div className="text-center text-3xl">{preset.emoji}</div>
        <div className="mb-2 text-center text-xs text-tertiary">
          {t("agentCreatePicker.roleLine", { name: preset.name, department: preset.department })}
        </div>
        <label className="text-xs text-tertiary">{t("agentCreatePicker.nameLabel")}</label>
        <div className="mt-1 flex gap-2">
          <input data-testid="preset-name-input" value={name} onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === "Enter" && void submit()}
            className="flex-1 rounded-md border border-hairline bg-surface px-3 py-2 text-center text-base font-semibold text-primary" />
          <button data-testid="preset-reshuffle" title={t("agentCreatePicker.reshuffle")}
            onClick={() => setName(randomPersonName(existingNames))}
            className="rounded-md bg-surface px-3">🎲</button>
        </div>
        {dup && <div className="mt-1 text-center text-xs text-danger">{t("agentCreatePicker.nameTaken")}</div>}
        <div className="mt-2 rounded-md bg-surface p-2 text-xs text-secondary">{preset.description}</div>
        <button data-testid="preset-save-btn" disabled={!valid} onClick={() => void submit()}
          className="mt-2 w-full rounded-md bg-accent px-3 py-2 text-sm text-white disabled:opacity-40">
          {saving ? t("agentCreatePicker.saving") : t("agentCreatePicker.saveAsMine")}
        </button>
      </div>
      <button data-testid="preset-back" onClick={onBack} className="self-start text-xs text-tertiary">{t("agentCreatePicker.backToList")}</button>
    </div>
  );
}
