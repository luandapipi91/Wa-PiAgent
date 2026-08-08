import { useTranslation } from "../../i18n/useTranslation";
import { Modal } from "./Modal";

interface ConfirmDialogProps {
  title: string;
  message: string;
  confirmText?: string;   // 默认「确认」
  cancelText?: string;    // 默认「取消」
  danger?: boolean;       // 危险操作（删除），确认按钮变红
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title, message,
  confirmText, cancelText,
  danger = false,
  onConfirm, onCancel,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const confirm = confirmText ?? t("ui.confirmDialog.defaultConfirm");
  const cancel = cancelText ?? t("ui.confirmDialog.defaultCancel");
  return (
    <Modal onClose={onCancel} width={400} data-testid="confirm-dialog">
      <div className="p-4 border-b border-hairline">
        <div className="text-primary font-bold text-sm">{title}</div>
      </div>
      <div className="p-4 text-sm text-secondary leading-relaxed">{message}</div>
      <div className="flex justify-end gap-2 p-3 border-t border-hairline">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 rounded-sm text-sm bg-surface-hover text-secondary border border-hairline transition-colors hover:text-primary"
          data-testid="confirm-cancel"
        >{cancel}</button>
        <button
          onClick={onConfirm}
          className="px-3 py-1.5 rounded-sm text-sm border-0 cursor-pointer"
          style={{
            background: danger ? "var(--danger)" : "var(--brand)",
            color: danger ? "var(--on-danger)" : "var(--on-brand)",
          }}
          data-testid="confirm-ok"
        >{confirm}</button>
      </div>
    </Modal>
  );
}
