import type { ToolCall, ToolResultMessage } from "@hiagent/shared";

interface Props {
  toolCall: ToolCall;
  result?: ToolResultMessage;
  targetDisplayName?: string;
}

export function DelegateCard({ toolCall, result, targetDisplayName }: Props) {
  const args = toolCall.arguments as { action?: string; to?: string; message?: string };
  return (
    <div className="rounded-lg p-2 my-1" style={{ background: "rgba(250,179,135,0.08)", border: "1px solid rgba(250,179,135,0.3)" }} data-testid={`delegate-${toolCall.id}`}>
      <div className="text-xs" style={{ color: "#fab387" }}>
        ↪ 委派给 {targetDisplayName ?? args.to} · {args.action === "ask" ? "等待回复" : "已通知"}
      </div>
      <div className="text-sm mt-1">📋 提问：{args.message}</div>
      {result && (
        <div className="text-sm mt-1 pl-2" style={{ borderLeft: "2px solid #a6e3a1" }}>
          <div className="text-xs" style={{ color: "#a6e3a1" }}>✓ {targetDisplayName ?? args.to} 的回复</div>
          {result.content.map((c: any, i: number) => c.type === "text" && <div key={i}>{c.text}</div>)}
        </div>
      )}
    </div>
  );
}
