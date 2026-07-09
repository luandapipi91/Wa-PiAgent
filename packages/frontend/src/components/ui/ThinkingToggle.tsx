interface Props {
  value: "disabled" | "high";
  onChange: (value: "disabled" | "high") => void;
}

export function ThinkingToggle({ value, onChange }: Props) {
  return (
    <button
      data-testid="thinking-toggle"
      onClick={() => onChange(value === "disabled" ? "high" : "disabled")}
      className={`text-xs px-2 py-0.5 rounded-pill border-0 cursor-pointer transition-colors ${
        value === "high"
          ? "bg-accent-soft text-accent"
          : "bg-surface-hover text-tertiary"
      }`}
    >
      思考 {value === "high" ? "high" : "关"}
    </button>
  );
}
