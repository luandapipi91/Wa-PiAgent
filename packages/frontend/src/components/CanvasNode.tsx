import { Handle, Position } from "reactflow";
import type { AgentConfig, AgentState } from "hiagent-shared";

export function CanvasNode({ data }: { data: { agent: AgentConfig; state?: AgentState } }) {
  const { agent, state } = data;
  const status = state?.status ?? "idle";
  const borderColor = status === "thinking" ? "#89b4fa" : status === "blocked" ? "#fab387" : "#6c7086";
  return (
    <div className="relative">
      <Handle type="target" position={Position.Top} />
      <div className="bg-base rounded-[10px] border-2 p-[10px_14px] min-w-[90px] text-center"
           style={{ borderColor, boxShadow: status === "thinking" ? "0 0 20px rgba(137,180,250,0.3)" : status === "blocked" ? "0 0 15px rgba(250,179,135,0.4)" : "none" }}
           data-pulse={status === "blocked" ? "true" : undefined}>
        <div className="text-[22px]">{agent.avatar}</div>
        <div className="font-semibold text-[12px] mt-0.5" style={{ color: borderColor }}>{agent.displayName}</div>
        <div className="text-[9px] mt-0.5" style={{ color: borderColor }}>
          {status === "thinking" ? "● thinking" : status === "blocked" ? "⏸ 等待回复" : "○ idle"}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
