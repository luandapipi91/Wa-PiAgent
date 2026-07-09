import { Modal } from "./ui/Modal";
import { ProviderSection } from "./settings/ProviderSection";
import { SkillSection } from "./settings/SkillSection";
import { useSettingsStore } from "../store/settings";

interface Props {
  onClose: () => void;
}

export function SettingsModal({ onClose }: Props) {
  const activeSection = useSettingsStore(s => s.activeSection);
  const setSection = useSettingsStore(s => s.setSection);

  return (
    <Modal onClose={onClose} width={900} data-testid="settings-modal">
      <div className="p-4 border-b border-hairline">
        <span className="text-primary font-bold text-base">系统设置</span>
      </div>
      <div className="flex" style={{ minHeight: 500, maxHeight: "75vh" }}>
        {/* 左侧导航：模型管理 + 技能 */}
        <nav className="w-40 border-r border-hairline p-2 flex flex-col gap-1">
          <button
            onClick={() => setSection("models")}
            className="px-2 py-1.5 rounded-sm text-sm font-medium text-left"
            style={activeSection === "models"
              ? { background: "var(--surface-hover)", color: "var(--brand)" }
              : { color: "var(--secondary)" }}
          >模型管理</button>
          <button
            onClick={() => setSection("skills")}
            className="px-2 py-1.5 rounded-sm text-sm font-medium text-left"
            style={activeSection === "skills"
              ? { background: "var(--surface-hover)", color: "var(--brand)" }
              : { color: "var(--secondary)" }}
          >技能</button>
        </nav>
        {/* 右侧内容 */}
        <div className="flex-1 overflow-auto">
          {activeSection === "models" && <ProviderSection />}
          {activeSection === "skills" && <SkillSection />}
        </div>
      </div>
    </Modal>
  );
}
