import { Handle, Position } from "reactflow";
import { AGENT_DEFS } from "@hiagent/shared";
import { STATUS_COLORS } from "../../theme/colors";
import type { CanvasNodeData } from "./types";

const STATUS_LABEL: Record<string, string> = {
  idle: "○ idle",
  thinking: "● thinking",
  blocked: "⏸ 等待回复",
};

export function CanvasNode({ data }: { data: CanvasNodeData }) {
  const def = AGENT_DEFS[data.agentName];
  const color = STATUS_COLORS[data.status];
  return (
    <div
      className="rounded-lg px-3 py-2 min-w-[90px]"
      style={{
        background: "#181825",
        border: `2px solid ${color}`,
        boxShadow: data.status !== "idle" ? `0 0 20px ${color}40` : "none",
      }}
      data-testid={`canvas-node-${data.agentName}`}
    >
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <div className="flex items-center gap-1">
        <span className="text-lg">{def.emoji}</span>
        <span className="text-sm text-text">{def.label}</span>
      </div>
      <div className="text-[9px] mt-0.5" style={{ color }}>
        {STATUS_LABEL[data.status]}
      </div>
      {data.tokenCount !== undefined && (
        <div className="text-[9px] text-overlay">
          {(data.tokenCount / 1000).toFixed(1)}k tok
        </div>
      )}
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
}
