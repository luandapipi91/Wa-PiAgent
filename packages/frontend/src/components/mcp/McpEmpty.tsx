import { useTranslation } from "../../i18n/useTranslation";

export function McpEmpty() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center py-16" data-testid="mcp-empty">
      <div
        className="flex items-center justify-center text-3xl mb-4"
        style={{
          width: 72, height: 72, borderRadius: 20,
          background: "linear-gradient(135deg, var(--surface-elevated), var(--surface-hover))",
          border: "1px solid var(--hairline)",
        }}
      >🔌</div>
      <h4 className="font-extrabold text-lg mb-1.5 text-primary">{t("mcpEmpty.title")}</h4>
      <p className="text-[calc(13px*var(--font-scale))] text-tertiary text-center leading-relaxed">
        {t("mcpEmpty.hint1")}<br />
        {t("mcpEmpty.hint2")}
      </p>
    </div>
  );
}
