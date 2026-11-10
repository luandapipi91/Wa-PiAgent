// KbList — 知识库列表（任务 B2）
//
// props 注入点（测试契约）：onDelete/onToggleWatch/onShowFailed/onEdit/onReindex
// 可选，缺省回退到 knowledge store 的同名实现（KnowledgePage 不传 props 即走真实链路）。
// 删除复用现有 ConfirmDialog（审查重点 5：先确认再删）。
import { useEffect, useState } from "react";
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
  /** 取消进行中的索引（B4）；缺省回退到 store 的 cancelIndex */
  onCancel?: (id: string) => void;
}

export function KbList({
  kbs,
  onDelete,
  onToggleWatch,
  onShowFailed,
  onEdit,
  onReindex,
  onCancel,
}: Props) {
  const { t } = useTranslation();
  const { deleteKb, setAutoWatch, cancelIndex } = useKnowledgeStore();
  // 待确认删除的库 id（null = 无确认框）
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // 渲染前按 id 复查状态：确认框开着时库可能被外部（watcher 自动重建 / 他处重建）转为索引中，
  // 那种情况下 kernel 会拒删除（400），确认框应当自动消失而不是让用户确认完才吃错
  const confirmTarget = confirmDelete ? kbs.find((k) => k.id === confirmDelete) : undefined;
  const confirmTargetBusy =
    confirmTarget?.status === "indexing" || confirmTarget?.status === "scanning";
  // 目标变 busy 时直接清空 state（而非只在渲染时跳过）：否则库脱离 busy（取消后回 ready/error）
  // 时旧 id 会让确认框复活，而那一下点下去是不可逆删库
  useEffect(() => {
    if (confirmTargetBusy) setConfirmDelete(null);
  }, [confirmTargetBusy]);

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
          onCancel={() => (onCancel ?? cancelIndex)(kb.id)}
        />
      ))}

      {/* 删除确认弹窗（目标库转为索引中时不渲染） */}
      {confirmDelete && !confirmTargetBusy && (
        <ConfirmDialog
          title={t("kb.deleteTitle")}
          message={t("kb.deleteMessage", {
            name: confirmTarget?.name ?? confirmDelete,
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
