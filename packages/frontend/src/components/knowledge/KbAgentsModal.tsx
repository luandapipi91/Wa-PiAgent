// 知识库侧的「关联智能体」管理弹窗：列出所有智能体（命名 agent + 内置 subagent），
// 勾选即建立/解除与该库的绑定（即时保存，失败回滚勾选态并 toast）。
// 数据来源：GET /api/agents（命名，含完整 config）与 GET /api/subagents（内置，含 override）。
// 关联关系反向写在 agent 的 knowledgeBaseIds / subagent override 上——与智能体编辑页同一份数据。
import { useEffect, useState } from "react";
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

export function KbAgentsModal({ kb, onClose }: Props) {
  const { t } = useTranslation();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

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
        setRows([
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
        ]);
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

  const toggle = async (row: Row, next: boolean) => {
    const key = `${row.kind}:${row.key}`;
    setSaving(key);
    // 乐观更新：失败时回滚到原状
    setRows((prev) =>
      (prev ?? []).map((r) =>
        `${r.kind}:${r.key}` === key ? ({ ...r, bound: next } as Row) : r,
      ),
    );
    try {
      if (row.kind === "agent") {
        const ids = new Set(row.config.knowledgeBaseIds ?? []);
        if (next) ids.add(kb.id);
        else ids.delete(kb.id);
        await api.put(`/api/agents/${encodeURIComponent(row.key)}/config`, {
          config: { ...row.config, knowledgeBaseIds: [...ids] },
        });
      } else {
        const current = row.info.override?.knowledgeBaseIds ?? [];
        const ids = new Set(current);
        if (next) ids.add(kb.id);
        else ids.delete(kb.id);
        await api.put("/api/subagents/override", {
          override: {
            type: row.info.name,
            model: row.info.override?.model ?? null,
            thinking: row.info.override?.thinking ?? null,
            knowledgeBaseIds: [...ids],
          },
        });
      }
    } catch (e) {
      setRows((prev) =>
        (prev ?? []).map((r) =>
          `${r.kind}:${r.key}` === key ? ({ ...r, bound: !next } as Row) : r,
        ),
      );
      useToastStore.getState().add(formatApiError(e), "error");
    } finally {
      setSaving(null);
    }
  };

  const boundCount = (rows ?? []).filter((r) => r.bound).length;

  return (
    <Modal onClose={onClose} width={460} data-testid="kb-agents-modal">
      <div
        className="px-4 py-3 flex items-center justify-between"
        style={{ borderBottom: "1px solid var(--hairline)" }}
      >
        <span className="text-primary font-bold text-sm">
          {t("kb.agentsTitle", { name: kb.name })}
        </span>
        <span className="text-tertiary text-[calc(11px*var(--font-scale))]">
          {t("kb.agentsBoundCount", { count: boundCount })}
        </span>
      </div>
      <div className="p-3 overflow-y-auto" style={{ maxHeight: "60vh" }}>
        {rows === null ? (
          <div className="text-tertiary text-[calc(12px*var(--font-scale))] py-6 text-center">
            {t("kb.agentsLoading")}
          </div>
        ) : rows.length === 0 ? (
          <div className="text-tertiary text-[calc(12px*var(--font-scale))] py-6 text-center">
            {t("kb.agentsEmpty")}
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            {rows.map((row) => {
              const key = `${row.kind}:${row.key}`;
              return (
                <label
                  key={key}
                  className="flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer text-[calc(12px*var(--font-scale))]"
                  style={{ border: "1px solid var(--hairline)" }}
                >
                  <input
                    type="checkbox"
                    checked={row.bound}
                    disabled={saving === key}
                    onChange={(e) => void toggle(row, e.target.checked)}
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
        <div className="text-tertiary text-[calc(10.5px*var(--font-scale))] mt-3">
          {t("kb.agentsHint")}
        </div>
      </div>
    </Modal>
  );
}
