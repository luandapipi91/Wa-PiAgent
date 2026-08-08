import { useTranslation } from "../../i18n/useTranslation";
import { Modal } from "../ui/Modal";
import { ProviderForm } from "./ProviderForm";
import type { ModelProvider } from "@wa-pi/shared";

interface Props {
  initial?: ModelProvider;   // 编辑时传，新增时不传
  onClose: () => void;
}

/** 设置页弹窗壳：header + ProviderForm（表单主体在 ProviderForm，向导复用） */
export function ProviderFormModal({ initial, onClose }: Props) {
  const { t } = useTranslation();
  return (
    <Modal onClose={onClose} width={640} closeOnOverlayClick={false} data-testid="provider-form-modal">
      <div className="p-4 border-b border-hairline">
        <span className="text-primary font-bold text-sm">{initial ? t("settings.provider.editTitle") : t("settings.provider.addTitle")}</span>
      </div>
      <ProviderForm initial={initial} onSaved={onClose} onCancel={onClose} />
    </Modal>
  );
}
