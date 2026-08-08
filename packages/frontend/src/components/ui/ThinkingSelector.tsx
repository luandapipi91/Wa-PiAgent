import type { ThinkingLevel } from "@wa-pi/shared";
import { useTranslation } from "../../i18n/useTranslation";

const LABEL_KEYS: Record<ThinkingLevel, string> = {
  disabled: "ui.thinkingSelector.optionDisabled",
  medium: "ui.thinkingSelector.optionMedium",
  high: "ui.thinkingSelector.optionHigh",
  max: "ui.thinkingSelector.optionMax",
};

interface Props {
  value: ThinkingLevel;
  onChange: (value: ThinkingLevel) => void;
}

export function ThinkingSelector({ value, onChange }: Props) {
  const { t } = useTranslation();
  return (
    <select
      data-testid="thinking-selector"
      value={value}
      onChange={e => onChange(e.target.value as ThinkingLevel)}
      aria-label={t("ui.thinkingSelector.ariaLabel")}
      className="bg-transparent text-xs text-secondary outline-none cursor-pointer"
    >
      <option value="disabled">{t(LABEL_KEYS.disabled)}</option>
      <option value="medium">{t(LABEL_KEYS.medium)}</option>
      <option value="high">{t(LABEL_KEYS.high)}</option>
      <option value="max">{t(LABEL_KEYS.max)}</option>
    </select>
  );
}
