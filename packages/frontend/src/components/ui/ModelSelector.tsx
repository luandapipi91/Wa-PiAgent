import { useEffect, useMemo, useRef } from "react";
import { useProvidersStore } from "../../store/providers";
import { useTranslation } from "../../i18n/useTranslation";
import { resolveProviderSlug } from "@wa-pi/shared";
import { AutoWidthSelect } from "./AutoWidthSelect";

interface Props {
  value: string | null;
  onChange: (modelId: string) => void;
  disabled?: boolean;
  /**
   * 是否允许 auto-select（默认 true）。
   * 会话 prefs 冷加载间隙（value 暂时为 null 但 DB 里可能有值）必须传 false，
   * 否则 auto-select 会抢在 loadSession 完成前把第一个模型写进会话 prefs 与 defaults。
   */
  autoSelectEnabled?: boolean;
}

export function ModelSelector({
  value,
  onChange,
  disabled,
  autoSelectEnabled = true,
}: Props) {
  const providers = useProvidersStore((s) => s.providers);
  const { t } = useTranslation();
  const models = useMemo(() => {
    const slugs: string[] = [];
    return providers.flatMap((p) => {
      const slug = resolveProviderSlug(p, slugs);
      slugs.push(slug);
      return p.models.map((m) => ({
        ...m,
        providerName: p.name,
        providerSlug: slug,
      }));
    });
  }, [providers]);
  const fullValue = value ?? "";

  // 未选模型时自动选择第一个可用模型，避免发送按钮被 disabled placeholder 卡死。
  // 用 ref 确保每个 ModelSelector 实例仅触发一次（新会话、新建模型等场景）。
  // value 清空（切到无 pref 的会话）时重置 ref，允许再次 auto-select。
  const autoSelectedRef = useRef(false);
  useEffect(() => {
    if (!fullValue) autoSelectedRef.current = false;
  }, [fullValue]);
  useEffect(() => {
    if (
      !autoSelectEnabled ||
      fullValue ||
      models.length === 0 ||
      autoSelectedRef.current
    )
      return;
    autoSelectedRef.current = true;
    onChange(`${models[0].providerSlug}/${models[0].id}`);
  }, [autoSelectEnabled, fullValue, models, onChange]);

  // 兼容旧数据：已保存的值匹配不上任何选项时，按 id 部分兜底匹配——
  // 覆盖裸 model id（"deepseek-v4-pro"）与过期 slug（"deep/deepseek-v4-pro"，provider 改名后残留），
  // 唯一命中时自动重钉到正确的 slug/id，避免发送闸门被失效 prefs 卡死。
  useEffect(() => {
    if (!fullValue) return;
    const matchesFull = models.some(
      (m) => `${m.providerSlug}/${m.id}` === fullValue,
    );
    if (matchesFull) return;
    const idPart = fullValue.slice(fullValue.lastIndexOf("/") + 1);
    const matches = models.filter((m) => m.id === idPart);
    if (matches.length === 1) {
      onChange(`${matches[0].providerSlug}/${matches[0].id}`);
    }
  }, [fullValue, models, onChange]);

  // 选项列表（含不可选的占位项）：AutoWidthSelect 靠它同时算出宽度与显示文案。
  // 注意：必须在下面「无模型」的 early return 之前算，否则 models.length 从 0 变为 >0
  // 时 hook 数量会变，直接触发 React 的 hooks 顺序报错。
  const options = useMemo(
    () => [
      {
        value: "",
        label: t("ui.modelSelector.placeholderOption"),
        disabled: true,
      },
      ...models.map((m) => ({
        value: `${m.providerSlug}/${m.id}`,
        label: `${m.providerName}/${m.id}`,
      })),
    ],
    [models, t],
  );

  if (models.length === 0) {
    return (
      <span className="text-xs text-tertiary">
        {t("ui.modelSelector.notConfigured")}
      </span>
    );
  }

  return (
    <AutoWidthSelect
      testId="model-selector"
      ariaLabel={t("ui.modelSelector.ariaLabel")}
      value={fullValue}
      onChange={onChange}
      options={options}
      disabled={disabled}
    />
  );
}
