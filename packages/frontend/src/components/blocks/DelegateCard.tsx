import { useState } from "react";
import type { ToolCall, ToolResultMessage } from "@hiagent/shared";

interface Props {
  toolCall: ToolCall;
  result?: ToolResultMessage;
}

export function DelegateCard({ toolCall, result }: Props) {
  const [open, setOpen] = useState(false);
  const args = toolCall.arguments as { agent?: string; task?: string };
  const full = result?.content.map((c: ToolResultMessage["content"][number]) => (c.type === "text" ? c.text : "")).join("\n") ?? "";
  const summary = full.length > 120 ? `${full.slice(0, 120)}…` : full;
  const failed = !!result?.isError;
  const statusColor = failed ? "var(--danger)" : "#a6e3a1";
  return (
    <div className="rounded-lg p-2 my-1" style={{ background: "rgba(250,179,135,0.08)", border: "1px solid rgba(250,179,135,0.3)" }} data-testid={`delegate-${toolCall.id}`}>
      <div className="text-xs flex items-center" style={{ color: "#fab387" }}>
        <span>↪ 委派给 {args.agent}</span>
        <span className="ml-auto inline-flex items-center gap-1">
          {!result && (
            <span className="inline-block w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ border: "2px solid rgba(250,179,135,0.35)", borderTopColor: "#fab387", animation: "spin 0.8s linear infinite" }} />
          )}
          {result ? (failed ? "✗ 失败" : "✓ 完成") : "执行中"}
        </span>
      </div>
      <div className="text-sm mt-1">📋 任务：{args.task}</div>
      {result && (
        <>
          <div className="text-sm mt-1 pl-2" style={{ borderLeft: `2px solid ${statusColor}` }}>
            <div className="text-xs" style={{ color: statusColor }}>{failed ? "✗" : "✓"} {args.agent} 的回复</div>
            {open ? (
              <div data-testid={`delegate-full-${toolCall.id}`}>{full}</div>
            ) : (
              <div>{summary}</div>
            )}
          </div>
          <button className="text-xs text-tertiary mt-1" onClick={() => setOpen(o => !o)} data-testid="delegate-expand">
            {open ? "▴ 收起" : "▾ 展开完整回复"}
          </button>
        </>
      )}
    </div>
  );
}
