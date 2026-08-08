import { Icon } from "./ui/Icon";
import { useTranslation } from "../i18n/useTranslation";

interface Props {
  onNewProject: () => void;
}

export function EmptyState({ onNewProject }: Props) {
  const { t } = useTranslation();
  return (
    <div className="flex-1 flex flex-col items-center justify-center p-10 text-center" data-testid="empty-state">
      <div className="w-[72px] h-[72px] rounded-xl flex items-center justify-center text-3xl mb-5 border border-hairline shadow-md text-accent"
        style={{ background: "linear-gradient(135deg, var(--surface-elevated), var(--surface))" }}>
        <Icon name="rocket" size={34} />
      </div>
      <div className="text-[calc(22px*var(--font-scale))] font-extrabold tracking-tight text-primary mb-2">{t("emptyState.title")}</div>
      <div className="text-sm text-secondary max-w-[360px] leading-relaxed mb-6">
        {t("emptyState.subtitle")}
      </div>
      <button
        onClick={onNewProject}
        className="px-[22px] py-2.5 rounded-pill bg-brand text-white text-sm font-semibold border-0 cursor-pointer shadow-md transition-all hover:-translate-y-px hover:shadow-lg inline-flex items-center gap-1.5"
        data-testid="empty-new-project"
      ><Icon name="plus" size={14} /> {t("emptyState.newProject")}</button>
    </div>
  );
}
