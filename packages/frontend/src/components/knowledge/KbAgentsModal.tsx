// 知识库侧的「关联智能体」管理弹窗：列出所有智能体（命名 agent + 内置 subagent），
// 勾选后点「确认」才批量写入（「取消」放弃改动）——避免误触即时生效。
// 数据来源：GET /api/agents（命名，含完整 config）与 GET /api/subagents（内置，含 override）。
// 关联关系反向写在 agent 的 knowledgeBaseIds / subagent override 上——与智能体编辑页同一份数据。
import { useEffect, useMemo, useState } from "react";
import type { AgentConfig, KbInfo, SubagentInfo } from "@wa-pi/shared";
import { Modal } from "../ui/Modal";
import { useTranslation } from "../../i18n/useTranslation";
import { api } from "../../api-client";
import { formatApiError } from "../../util/kernel-error";
import { useToastStore } from "../../store/toast";

interface Props {
  kb: KbInfo;
  onClose: () => void;
}

type Row =
  | { kind: "agent"; key: string; label: string; bound: boolean; config: AgentConfig }
  | { kind: "subagent"; key: string; label: string; bound: boolean; info: SubagentInfo };

const rowKey = (r: Row) => `${r.kind}:${r.key}`;

export function KbAgentsModal({ kb, onClose }: Props) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Row[] | null>(null);
  // 勾选态先记在本地，点「确认」才落盘；初值 = 当前已绑定的智能体
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [agentsRes, subsRes] = await Promise.all([
          api.get("/api/agents"),
          api.get("/api/subagents"),
        ]);
        if (cancelled) return;
        const agents: AgentConfig[] = (agentsRes as any)?.agents ?? [];
        const subs: SubagentInfo[] = (subsRes as any)?.subagents ?? [];
        const next: Row[] = [
          ...agents.map<Row>((config) => ({
            kind: "agent",
            key: config.displayName,
            label: config.displayName,
            bound: (config.knowledgeBaseIds ?? []).includes(kb.id),
            config,
          })),
          ...subs.map<Row>((info) => ({
            kind: "subagent",
            key: info.name,
            label: info.displayName,
            bound: (info.override?.knowledgeBaseIds ?? []).includes(kb.id),
            info,
          })),
        ];
        setRows(next);
        setSelected(new Set(next.filter((r) => r.bound).map(rowKey)));
      } catch (e) {
        if (!cancelled) {
          useToastStore.getState().add(formatApiError(e), "error");
          setRows([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kb.id]);

  /** 名称/标识命中搜索词（大小写不敏感） */
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows ?? [];
    return (rows ?? []).filter(
      (r) => r.label.toLowerCase().includes(q) || r.key.toLowerCase().includes(q),
    );
  }, [rows, search]);

  const boundCount = selected.size;

  const save = async (row: Row, next: boolean) => {
    if (row.kind === "agent") {
      const ids = new Set(row.config.knowledgeBaseIds ?? []);
      if (next) ids.add(kb.id);
      else ids.delete(kb.id);
      await api.put(`/api/agents/${encodeURIComponent(row.key)}/config`, {
        config: { ...row.config, knowledgeBaseIds: [...ids] },
      });
    } else {
      const ids = new Set(row.info.override?.knowledgeBaseIds ?? []);
      if (next) ids.add(kb.id);
      else ids.delete(kb.id);
      // 只改 knowledgeBaseIds，保留用户已设的 model / thinking
      await api.put("/api/subagents/override", {
        override: {
          type: row.info.name,
          model: row.info.override?.model ?? null,
          thinking: row.info.override?.thinking ?? null,
          knowledgeBaseIds: [...ids],
        },
      });
    }
  };

  const onConfirm = async () => {
    const changes = (rows ?? []).filter((r) => selected.has(rowKey(r)) !== r.bound);
    if (changes.length === 0) {
      onClose();
      return;
    }
    setSubmitting(true);
    const failed: string[] = [];
    const savedKeys = new Set<string>();
    for (const row of changes) {
      const next = selected.has(rowKey(row));
      try {
        await save(row, next);
        savedKeys.add(rowKey(row));
      } catch {
        failed.push(row.label);
      }
    }
    setSubmitting(false);
    if (failed.length > 0) {
      // 成功的项更新基线（再点确认不会重复提交），失败的项保持待提交并提示
      setRows((prev) =>
        (prev ?? []).map((r) =>
          savedKeys.has(rowKey(r)) ? ({ ...r, bound: selected.has(rowKey(r)) } as Row) : r,
        ),
      );
      useToastStore.getState().add(t("kb.agentsSaveFailed", { names: failed.join("、") }), "error");
      return;
    }
    onClose();
  };

  return (
    <Modal onClose={onClose} width={460} data-testid="kb-agents-modal">
      <div
        className="px-4 py-3 flex items-center justify-between"
        style={{ borderBottom: "1px solid var(--hairline)" }}
      >
        <span className="text-brand font-bold text-sm">
          {t("kb.agentsTitle", { name: kb.name })}
        </span>
        <span className="text-tertiary text-[calc(11px*var(--font-scale))]">
          {t("kb.agentsBoundCount", { count: boundCount })}
        </span>
      </div>
      <div className="px-3 pt-2">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("kb.agentsSearchPlaceholder")}
          data-testid="kb-agents-search"
          className="w-full px-2 py-1.5 rounded-md text-[calc(12px*var(--font-scale))] border border-hairline bg-surface text-primary placeholder:text-tertiary outline-none appearance-none focus:border-brand"
        />
      </div>
      <div
        className="px-3 py-2 overflow-y-auto"
        data-testid="kb-agents-list"
        style={{ maxHeight: "40vh", minHeight: 120, overflowY: "auto" }}
      >
        {rows === null ? (
          <div className="text-tertiary text-[calc(12px*var(--font-scale))] py-6 text-center">
            {t("kb.agentsLoading")}
          </div>
        ) : visible.length === 0 ? (
          <div className="text-tertiary text-[calc(12px*var(--font-scale))] py-6 text-center">
            {search.trim() ? t("kb.agentsNoMatch") : t("kb.agentsEmpty")}
          </div>
        ) : (
          <div className="flex flex-col">
            {visible.map((row) => {
              const k = rowKey(row);
              return (
                <label
                  key={k}
                  className="flex items-center gap-2 px-2 py-2 cursor-pointer text-[calc(12px*var(--font-scale))]"
                  style={{ borderBottom: "1px solid var(--hairline)", userSelect: "none" }}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(k)}
                    disabled={submitting}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(k);
                      else next.delete(k);
                      setSelected(next);
                    }}
                    data-testid={`kb-agent-${row.key}`}
                  />
                  <span className="text-primary">{row.label}</span>
                  <span className="text-tertiary text-[calc(10px*var(--font-scale))]">
                    {row.kind === "subagent" ? t("kb.agentsBuiltinTag") : t("kb.agentsNamedTag")}
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </div>
      <div className="px-3 pb-1 text-tertiary text-[calc(10.5px*var(--font-scale))]">
        {t("kb.agentsHint")}
      </div>
      <div
        className="px-3 py-2.5 flex items-center justify-end gap-2"
        style={{ borderTop: "1px solid var(--hairline)" }}
      >
        <button
          type="button"
          onClick={onClose}
          disabled={submitting}
          data-testid="kb-agents-cancel"
          className="px-3 py-1.5 rounded-md text-[calc(12px*var(--font-scale))]"
          style={{ border: "1px solid var(--hairline)" }}
        >
          {t("kb.agentsCancel")}
        </button>
        <button
          type="button"
          onClick={() => void onConfirm()}
          disabled={submitting}
          data-testid="kb-agents-confirm"
          className="px-3 py-1.5 rounded-md text-[calc(12px*var(--font-scale))] text-white"
          style={{ background: "var(--accent)" }}
        >
          {t("kb.agentsConfirm")}
        </button>
      </div>
    </Modal>
  );
}
