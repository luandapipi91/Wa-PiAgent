import type { McpServerConfig } from "@wa-pi/shared";
import { Modal } from "../ui/Modal";
import { McpForm } from "./McpForm";
import { useTranslation } from "../../i18n/useTranslation";

interface Props {
  initial?: McpServerConfig;
  onSave: (config: McpServerConfig, originalName?: string) => void;
  onClose: () => void;
}

/** 新增/编辑 MCP 服务器的模态弹窗：Modal 壳 + 标题栏 + McpForm 表单体 */
export function McpFormModal({ initial, onSave, onClose }: Props) {
  const { t } = useTranslation();
  const title = initial
    ? t("mcpForm.editTitle", { name: initial.name })
    : t("mcpForm.addTitle");

  return (
    <Modal
      onClose={onClose}
      width={520}
      closeOnOverlayClick={false}
      data-testid="mcp-form-modal"
    >
      <div
        className="px-4 py-3 flex items-center justify-between"
        style={{ borderBottom: "1px solid var(--hairline)" }}
      >
        <span className="text-primary font-bold text-sm">{title}</span>
        <button
          onClick={onClose}
          className="text-tertiary text-xs"
          data-testid="mcp-form-modal-close"
        >
          ✕
        </button>
      </div>
      <div className="p-4 overflow-y-auto" style={{ maxHeight: "72vh" }}>
        <McpForm initial={initial} onSave={onSave} onCancel={onClose} />
      </div>
    </Modal>
  );
}
