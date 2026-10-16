import { useEffect, useMemo, useState } from "react";
import type { AgencyPreset, AgencyPresetMeta } from "@wa-pi/shared";
import { api } from "../../api-client";
import { randomPersonName } from "../../data/name-pool";
import { useAgentsStore } from "../../store/agents";
import { useToastStore } from "../../store/toast";
import { useTranslation } from "../../i18n/useTranslation";
import { Modal } from "../ui/Modal";
import { Icon } from "../ui/Icon";

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
        : <PresetPick existingNames={existingNames} onCreated={onCreated} onCancel={onCancel} />}
      {onCancel && tab === "blank" && (
        <button data-testid="picker-cancel" onClick={onCancel} className="self-end text-xs text-tertiary">{t("common.cancel")}</button>
      )}
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

/** 预设选择：搜索 + 部门筛选 + 部门分组 + 命名面板；右键卡片查看完整提示词 */
function PresetPick({ existingNames, onCreated, onCancel }: { existingNames: string[]; onCreated: (n: string) => void; onCancel?: () => void }) {
  const { t } = useTranslation();
  const [presets, setPresets] = useState<AgencyPresetMeta[]>([]);
  const [search, setSearch] = useState("");
  const [dept, setDept] = useState("");
  const [view, setView] = useState<View>({ kind: "list" });
  // 提示词预览：body 按需拉取，null = 加载中
  const [promptFor, setPromptFor] = useState<{ meta: AgencyPresetMeta; body: string | null } | null>(null);

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

  /** 部门列表（按预设出现顺序去重） */
  const departments = useMemo(
    () => Array.from(new Set(presets.map(p => p.department))),
    [presets],
  );

  const groups = useMemo(() => {
    const kw = search.trim().toLowerCase();
    const filtered = presets.filter(p => {
      if (dept && p.department !== dept) return false;
      if (!kw) return true;
      return p.name.toLowerCase().includes(kw) || p.description.toLowerCase().includes(kw);
    });
    const map = new Map<string, AgencyPresetMeta[]>();
    for (const p of filtered) {
      const arr = map.get(p.department) ?? [];
      arr.push(p);
      map.set(p.department, arr);
    }
    return Array.from(map.entries());
  }, [presets, search, dept]);

  /** 右键卡片：拉取完整提示词并弹出预览 */
  const showPrompt = async (p: AgencyPresetMeta) => {
    setPromptFor({ meta: p, body: null });
    try {
      const res = (await api.get(`/api/agents/presets/${encodeURIComponent(p.id)}`)) as { preset?: AgencyPreset };
      setPromptFor({ meta: p, body: res.preset?.body ?? "" });
    } catch (e) {
      setPromptFor(null);
      useToastStore.getState().add(e instanceof Error ? e.message : String(e), "error");
    }
  };

  if (view.kind === "naming") {
    return <NamingPanel preset={view.preset} existingNames={existingNames}
      onBack={() => setView({ kind: "list" })} onCreated={onCreated} onCancel={onCancel} />;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex gap-2">
        <input data-testid="preset-search-input" value={search} onChange={e => setSearch(e.target.value)}
          placeholder={t("agentCreatePicker.searchPlaceholder", { count: presets.length })}
          className="flex-1 rounded-md border border-hairline bg-surface px-3 py-2 text-sm text-primary" />
        <select data-testid="preset-dept-filter" value={dept} onChange={e => setDept(e.target.value)}
          className="rounded-md border border-hairline bg-surface px-2 py-2 text-xs text-primary">
          <option value="">{t("agentCreatePicker.allDepartments")}</option>
          {departments.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>
      <div className="text-xs text-tertiary">{t("agentCreatePicker.rightClickHint")}</div>
      <div className="flex max-h-[45vh] flex-col gap-3 overflow-auto">
        {groups.map(([deptName, list]) => (
          <div key={deptName}>
            {/* 计数放子 span：部门名独占直接文本节点，便于按名字断言 */}
            <div className="mb-1 text-xs font-medium text-tertiary">{deptName}<span>（{list.length}）</span></div>
            <div className="grid grid-cols-3 gap-2">
              {list.map(p => (
                <button key={p.id} data-testid={`preset-card-${p.id}`}
                  onClick={() => setView({ kind: "naming", preset: p })}
                  onContextMenu={e => { e.preventDefault(); void showPrompt(p); }}
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

      {onCancel && (
        <button data-testid="picker-cancel" onClick={onCancel} className="self-end text-xs text-tertiary">{t("common.cancel")}</button>
      )}

      {/* 提示词预览弹窗（右键卡片打开） */}
      {promptFor && (
        <Modal onClose={() => setPromptFor(null)} width={640} data-testid="preset-prompt-modal">
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-hairline">
            <div className="text-sm font-bold text-primary">
              {promptFor.meta.emoji} {promptFor.meta.name} · {promptFor.meta.department}
            </div>
            <button
              data-testid="preset-prompt-close"
              aria-label={t("common.close")}
              onClick={() => setPromptFor(null)}
              className="inline-flex items-center justify-center w-6 h-6 rounded-sm text-tertiary hover:text-primary cursor-pointer"
            >
              <Icon name="x" size={14} />
            </button>
          </div>
          <div className="px-5 py-4 max-h-[70vh] overflow-y-auto">
            {promptFor.body === null
              ? <div className="text-xs text-tertiary">{t("agentCreatePicker.promptLoading")}</div>
              : <pre data-testid="preset-prompt-body" className="whitespace-pre-wrap font-mono text-xs text-secondary">{promptFor.body}</pre>}
          </div>
        </Modal>
      )}
    </div>
  );
}

/** 命名面板：随机人名（🎲/手改）+ 角色能力 + 保存 */
function NamingPanel({ preset, existingNames, onBack, onCreated, onCancel }: {
  preset: AgencyPresetMeta; existingNames: string[];
  onBack: () => void; onCreated: (n: string) => void; onCancel?: () => void;
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
      {/* 返回列表与取消同行（左/右） */}
      <div className="flex items-center justify-between">
        <button data-testid="preset-back" onClick={onBack} className="text-xs text-tertiary">{t("agentCreatePicker.backToList")}</button>
        {onCancel && (
          <button data-testid="picker-cancel" onClick={onCancel} className="text-xs text-tertiary">{t("common.cancel")}</button>
        )}
      </div>
    </div>
  );
}
