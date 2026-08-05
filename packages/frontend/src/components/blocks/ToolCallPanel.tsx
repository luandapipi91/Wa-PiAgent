import { useState } from "react";
import type { ToolCall, ToolResultMessage } from "@wa-pi/shared";
import { Icon } from "../ui/Icon";

interface Props {
  toolCall: ToolCall;
  result?: ToolResultMessage;
}

export function ToolCallPanel({ toolCall, result }: Props) {
  const [open, setOpen] = useState(false);
  return (
    <div className="my-1 text-xs" data-testid={`toolcall-${toolCall.id}`}>
      <button onClick={() => setOpen(!open)} className="text-overlay hover:text-text inline-flex items-center gap-1" style={{ cursor: "pointer" }}>
        <Icon name="wrench" size={12} /> {toolCall.name}({JSON.stringify(toolCall.arguments)}) <Icon name={open ? "chevron-down" : "chevron-right"} size={10} />
      </button>
      {open && result && (
        <div className="mt-1 pl-2 border-l border-surface2 text-overlay">
          {result.content.map((c: any, i: number) => c.type === "text" && <div key={i}>{c.text}</div>)}
        </div>
      )}
    </div>
  );
}
