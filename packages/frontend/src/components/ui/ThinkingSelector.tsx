import type { ThinkingLevel } from "@hiagent/shared";

const LABELS: Record<ThinkingLevel, string> = {
  disabled: "思考 off",
  medium: "思考 mid",
  high: "思考 high",
  max: "思考 max",
};

interface Props {
  value: ThinkingLevel;
  onChange: (value: ThinkingLevel) => void;
}

export function ThinkingSelector({ value, onChange }: Props) {
  return (
    <select
      data-testid="thinking-selector"
      value={value}
      onChange={e => onChange(e.target.value as ThinkingLevel)}
      aria-label="思考强度"
      className="bg-transparent text-xs text-secondary outline-none cursor-pointer"
    >
      <option value="disabled">{LABELS.disabled}</option>
      <option value="medium">{LABELS.medium}</option>
      <option value="high">{LABELS.high}</option>
      <option value="max">{LABELS.max}</option>
    </select>
  );
}
