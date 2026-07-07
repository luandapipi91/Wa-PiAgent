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
  confirmText = "确认", cancelText = "取消",
  danger = false,
  onConfirm, onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal onClose={onCancel} width={400} data-testid="confirm-dialog">
      <div className="p-4 border-b border-surface2">
        <div className="text-text font-semibold">{title}</div>
      </div>
      <div className="p-4 text-sm text-subtext">{message}</div>
      <div className="flex justify-end gap-2 p-3 border-t border-surface2">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 rounded text-sm"
          style={{ background: "#313244", color: "#cdd6f4" }}
          data-testid="confirm-cancel"
        >{cancelText}</button>
        <button
          onClick={onConfirm}
          className="px-3 py-1.5 rounded text-sm"
          style={{
            background: danger ? "#f38ba8" : "#89b4fa",
            color: "#1e1e2e",
          }}
          data-testid="confirm-ok"
        >{confirmText}</button>
      </div>
    </Modal>
  );
}
