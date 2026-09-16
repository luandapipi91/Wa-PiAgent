// MemoryEmpty.tsx — 空状态组件
import { useTranslation } from "../../i18n/useTranslation";

interface Props {
  type: "memory" | "instructions" | "search" | "searching";
  /** type="searching" 时的检索词：显示在标题里 */
  query?: string;
}

export function MemoryEmpty({ type, query }: Props) {
  const { t } = useTranslation();
  if (type === "searching") {
    return (
      <div className="flex flex-col items-center justify-center py-16" data-testid="memory-empty-searching">
        <div
          className="flex items-center justify-center text-3xl mb-4"
          style={{
            width: 72, height: 72, borderRadius: 20,
            background: "linear-gradient(135deg, var(--surface-elevated), var(--surface-hover))",
            border: "1px solid var(--hairline)",
          }}
        >🔍</div>
        <h4 className="font-extrabold text-lg mb-1.5 text-primary">
          {query ? t("memoryEmpty.searchingTitle", { query }) : t("memory.searching")}
        </h4>
        <p className="text-[calc(13px*var(--font-scale))] text-tertiary text-center leading-relaxed">
          {t("memoryEmpty.searchingHint")}
        </p>
      </div>
    );
  }
  if (type === "search") {
    return (
      <div className="flex flex-col items-center justify-center py-16" data-testid="memory-empty-search">
        <div
          className="flex items-center justify-center text-3xl mb-4"
          style={{
            width: 72, height: 72, borderRadius: 20,
            background: "linear-gradient(135deg, var(--surface-elevated), var(--surface-hover))",
            border: "1px solid var(--hairline)",
          }}
        >🔍</div>
        <h4 className="font-extrabold text-lg mb-1.5 text-primary">{t("memoryEmpty.searchTitle")}</h4>
        <p className="text-[calc(13px*var(--font-scale))] text-tertiary text-center leading-relaxed">
          {t("memoryEmpty.searchHint")}
        </p>
      </div>
    );
  }
  if (type === "instructions") {
    return (
      <div className="flex flex-col items-center justify-center py-16" data-testid="memory-empty-instructions">
        <div
          className="flex items-center justify-center text-3xl mb-4"
          style={{
            width: 64, height: 64, borderRadius: 20,
            background: "linear-gradient(135deg, var(--surface-elevated), var(--surface-hover))",
            border: "1px solid var(--hairline)",
          }}
        >📄</div>
        <h4 className="font-extrabold text-base mb-1.5 text-primary">{t("memoryEmpty.instructionsTitle")}</h4>
        <p className="text-[calc(12.5px*var(--font-scale))] text-tertiary text-center leading-relaxed">
          {t("memoryEmpty.instructionsHint1")}<br />
          {t("memoryEmpty.instructionsHint2")}
        </p>
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center py-16" data-testid="memory-empty">
      <div
        className="flex items-center justify-center text-3xl mb-4"
        style={{
          width: 72, height: 72, borderRadius: 20,
          background: "linear-gradient(135deg, var(--surface-elevated), var(--surface-hover))",
          border: "1px solid var(--hairline)",
        }}
      >🧠</div>
      <h4 className="font-extrabold text-lg mb-1.5 text-primary">{t("memoryEmpty.memoryTitle")}</h4>
      <p className="text-[calc(13px*var(--font-scale))] text-tertiary text-center leading-relaxed">
        {t("memoryEmpty.memoryHint1")}<br />
        {t("memoryEmpty.memoryHint2")}
      </p>
    </div>
  );
}
