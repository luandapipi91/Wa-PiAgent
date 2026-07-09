import { useProvidersStore } from "../../store/providers";

interface Props {
  value: string | null;
  onChange: (modelId: string) => void;
  disabled?: boolean;
}

export function ModelSelector({ value, onChange, disabled }: Props) {
  const providers = useProvidersStore(s => s.providers);
  const models = providers.flatMap(p => p.models.map(m => ({ ...m, providerName: p.name })));
  const selected = models.find(m => m.id === value);

  if (models.length === 0) {
    return <span className="text-xs text-tertiary">未配置模型</span>;
  }

  return (
    <select
      data-testid="model-selector"
      value={value ?? ""}
      onChange={e => onChange(e.target.value)}
      disabled={disabled}
      className="bg-transparent text-xs text-secondary outline-none cursor-pointer disabled:cursor-not-allowed"
    >
      {models.map(m => (
        <option key={m.id} value={m.id}>{m.providerName}/{m.id}</option>
      ))}
    </select>
  );
}
