import { Modal } from "./ui/Modal";
import { ProviderSection } from "./settings/ProviderSection";

interface Props {
  onClose: () => void;
}

export function SettingsModal({ onClose }: Props) {
  return (
    <Modal onClose={onClose} width={900} data-testid="settings-modal">
      <div className="p-4 border-b border-hairline">
        <span className="text-primary font-bold text-base">系统设置</span>
      </div>
      <div className="flex" style={{ minHeight: 500, maxHeight: "75vh" }}>
        {/* 左侧导航：本次仅「模型管理」 */}
        <nav className="w-40 border-r border-hairline p-2 flex flex-col gap-1">
          <span className="px-2 py-1.5 rounded-sm text-sm font-medium" style={{ background: "var(--surface-hover)", color: "var(--brand)" }}>
            模型管理
          </span>
        </nav>
        {/* 右侧内容 */}
        <div className="flex-1 overflow-auto">
          <ProviderSection />
        </div>
      </div>
    </Modal>
  );
}
