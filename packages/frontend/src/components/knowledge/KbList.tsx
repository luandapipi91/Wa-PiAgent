// KbList — 知识库列表（任务 B2）
//
// props 注入点（测试契约）：onDelete/onToggleWatch/onShowFailed/onEdit/onReindex
// 可选，缺省回退到 knowledge store 的同名实现（KnowledgePage 不传 props 即走真实链路）。
// 删除复用现有 ConfirmDialog（审查重点 5：先确认再删）。
import { useState } from "react";
import type { KbInfo } from "@wa-pi/shared";
import { useKnowledgeStore } from "../../store/knowledge";
import { KbCard } from "./KbCard";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { useTranslation } from "../../i18n/useTranslation";

interface Props {
  kbs: KbInfo[];
  onDelete?: (id: string) => void;
  onToggleWatch?: (id: string, on: boolean) => void;
  onShowFailed?: (id: string) => void;
  onEdit?: (kb: KbInfo) => void;
  onReindex?: (id: string) => void;
}

export function KbList({
  kbs,
  onDelete,
  onToggleWatch,
  onShowFailed,
  onEdit,
  onReindex,
}: Props) {
  const { t } = useTranslation();
  const { deleteKb, setAutoWatch } = useKnowledgeStore();
  // 待确认删除的库 id（null = 无确认框）
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const handleDelete = (id: string) => {
    (onDelete ?? deleteKb)(id);
    setConfirmDelete(null);
  };

  if (kbs.length === 0) {
    return (
      <div
        className="text-center text-tertiary text-[calc(12.5px*var(--font-scale))] py-8"
        data-testid="kb-empty"
      >
        {t("kb.empty")}
      </div>
    );
  }

  return (
    <div data-testid="kb-list">
      {kbs.map((kb) => (
        <KbCard
          key={kb.id}
          kb={kb}
          onEdit={onEdit ? () => onEdit(kb) : undefined}
          onReindex={onReindex ? () => onReindex(kb.id) : undefined}
          onDelete={() => setConfirmDelete(kb.id)}
          onToggleWatch={(on) => (onToggleWatch ?? setAutoWatch)(kb.id, on)}
          onShowFailed={onShowFailed ? () => onShowFailed(kb.id) : undefined}
        />
      ))}

      {/* 删除确认弹窗 */}
      {confirmDelete && (
        <ConfirmDialog
          title={t("kb.deleteTitle")}
          message={t("kb.deleteMessage", {
            name: kbs.find((k) => k.id === confirmDelete)?.name ?? confirmDelete,
          })}
          confirmText={t("kb.deleteButton")}
          danger
          onConfirm={() => handleDelete(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}
