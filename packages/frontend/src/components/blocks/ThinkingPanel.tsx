import { useState } from "react";
import { Icon } from "../ui/Icon";

interface Props { thinking: string; }

export function ThinkingPanel({ thinking }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1" data-testid="thinking-panel">
      <button onClick={() => setOpen(!open)} className="text-xs text-overlay hover:text-text inline-flex items-center gap-1" style={{ cursor: "pointer" }}>
        <Icon name="thought" size={12} /> 思考过程 <Icon name={open ? "chevron-down" : "chevron-right"} size={10} />
      </button>
      {open && <div className="text-xs text-overlay italic mt-1 pl-2 border-l border-surface2 break-words">{thinking}</div>}
    </div>
  );
}
