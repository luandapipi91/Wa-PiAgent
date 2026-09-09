import type { ThinkingLevel } from "@wa-pi/shared";
import { useMemo } from "react";
import { useTranslation } from "../../i18n/useTranslation";
import { AutoWidthSelect } from "./AutoWidthSelect";

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
    const options = useMemo(
        () => [
            { value: "disabled", label: t(LABEL_KEYS.disabled) },
            { value: "medium", label: t(LABEL_KEYS.medium) },
            { value: "high", label: t(LABEL_KEYS.high) },
            { value: "max", label: t(LABEL_KEYS.max) },
        ],
        [t],
    );
    // 与 ModelSelector 共用 AutoWidthSelect：箭头样式、文字-箭头间距保持一致
    // （否则一边是自画 chevron、一边是各平台原生箭头，视觉不统一）
    return (
        <AutoWidthSelect
            testId="thinking-selector"
            ariaLabel={t("ui.thinkingSelector.ariaLabel")}
            value={value}
            onChange={(v) => onChange(v as ThinkingLevel)}
            options={options}
        />
    );
}
