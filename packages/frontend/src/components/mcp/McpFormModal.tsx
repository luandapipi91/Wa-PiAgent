import type { McpServerConfig } from "@wa-pi/shared";
import type { McpSaveResult } from "../../store/mcp";
import { Modal } from "../ui/Modal";
import { McpForm } from "./McpForm";
import { useTranslation } from "../../i18n/useTranslation";

interface Props {
  initial?: McpServerConfig;
  /** 保存（发 POST /api/mcp）：返回结果交给表单绑字段级错误；成功时由调用方关闭弹窗 */
  onSave: (
    config: McpServerConfig,
    originalName?: string,
  ) => Promise<McpSaveResult>;
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
