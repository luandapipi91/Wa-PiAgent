import { useEffect, useMemo } from "react";
import { useProvidersStore } from "../../store/providers";
import { slugifyProviderName } from "@hiagent/shared";

interface Props {
  value: string | null;
  onChange: (modelId: string) => void;
  disabled?: boolean;
}

export function ModelSelector({ value, onChange, disabled }: Props) {
  const providers = useProvidersStore(s => s.providers);
  const models = useMemo(() => {
    const slugs: string[] = [];
    return providers.flatMap(p => {
      const slug = slugifyProviderName(p.name, slugs);
      slugs.push(slug);
      return p.models.map(m => ({
        ...m,
        providerName: p.name,
        providerSlug: slug,
      }));
    });
  }, [providers]);
  const fullValue = value ?? "";

  // 兼容旧数据：已保存的值匹配不上任何选项时，按 id 部分兜底匹配——
  // 覆盖裸 model id（"deepseek-v4-pro"）与过期 slug（"deep/deepseek-v4-pro"，provider 改名后残留），
  // 唯一命中时自动重钉到正确的 slug/id，避免发送闸门被失效 prefs 卡死。
  useEffect(() => {
    if (!fullValue) return;
    const matchesFull = models.some(m => `${m.providerSlug}/${m.id}` === fullValue);
    if (matchesFull) return;
    const idPart = fullValue.slice(fullValue.lastIndexOf("/") + 1);
    const matches = models.filter(m => m.id === idPart);
    if (matches.length === 1) {
      onChange(`${matches[0].providerSlug}/${matches[0].id}`);
    }
  }, [fullValue, models, onChange]);

  if (models.length === 0) {
    return <span className="text-xs text-tertiary">未配置模型</span>;
  }

  return (
    <select
      data-testid="model-selector"
      value={fullValue}
      onChange={e => onChange(e.target.value)}
      disabled={disabled}
      aria-label="选择模型"
      className="bg-transparent text-xs text-secondary outline-none cursor-pointer disabled:cursor-not-allowed"
    >
      <option value="" disabled>选择模型</option>
      {models.map(m => (
        <option key={`${m.providerSlug}/${m.id}`} value={`${m.providerSlug}/${m.id}`}>
          {m.providerName}/{m.id}
        </option>
      ))}
    </select>
  );
}
