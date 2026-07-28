import { useState } from "react";

interface Props { thinking: string; }

export function ThinkingPanel({ thinking }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1" data-testid="thinking-panel">
      <button onClick={() => setOpen(!open)} className="text-xs text-overlay hover:text-text" style={{ cursor: "pointer" }}>
        💭 思考过程 {open ? "▾" : "▸"}
      </button>
      {open && <div className="text-xs text-overlay italic mt-1 pl-2 border-l border-surface2 break-words">{thinking}</div>}
    </div>
  );
}
