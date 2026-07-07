import { useMemo } from "react";
import ReactFlow, { Background } from "reactflow";
import "reactflow/dist/style.css";
import type { AgentName } from "@hiagent/shared";
import { useAgentsStore } from "../../store/agents";
import { useIntercomStore } from "../../store/intercom";
import { CanvasNode } from "./CanvasNode";
import type { CanvasNodeData } from "./types";

const NAMES: AgentName[] = ["product", "pm", "dev", "test"];

// 四角布局：product/pm 上排，dev/test 下排
const POSITIONS: Record<AgentName, { x: number; y: number }> = {
  product: { x: 100, y: 0 },
  pm: { x: 350, y: 0 },
  dev: { x: 100, y: 150 },
  test: { x: 350, y: 150 },
};

// 默认 partners 连线（灰色虚线，来自 4 角色 partners 关系）
const DEFAULT_PARTNERS: Array<[AgentName, AgentName]> = [
  ["product", "dev"],
  ["product", "pm"],
  ["pm", "dev"],
  ["pm", "test"],
  ["dev", "test"],
];

const nodeTypes = { agent: CanvasNode };

export function Canvas() {
  const states = useAgentsStore(s => s.states);
  const asksBySession = useIntercomStore(s => s.asksBySession);

  // 4 个 agent 节点：画布是全局视图，取该 agent 任一项目状态（第一个匹配）
  const nodes = useMemo(() => NAMES.map(name => {
    const entry = Object.entries(states).find(([k]) => k.endsWith(`:${name}`));
    const status = entry?.[1].status ?? "idle";
    const tokenCount = entry?.[1].tokenCount;
    return {
      id: name,
      type: "agent",
      position: POSITIONS[name],
      data: { agentName: name, status, tokenCount } as CanvasNodeData,
    };
  }), [states]);

  // 所有活跃 ask（跨会话）作为橙色动画连线
  const activeAsks = useMemo(() => {
    return Object.values(asksBySession).flat().filter(a => !a.resolved);
  }, [asksBySession]);

  const edges = useMemo(() => {
    const partnerEdges = DEFAULT_PARTNERS.map(([f, t]) => ({
      id: `${f}-${t}`,
      source: f,
      target: t,
      style: { stroke: "#6c7086", strokeDasharray: "4,3", strokeWidth: 2 },
    }));
    const askEdges = activeAsks.map(a => ({
      id: `ask-${a.messageId}`,
      source: a.from,
      target: a.to,
      animated: true,
      style: { stroke: "#fab387", strokeDasharray: "6,4", strokeWidth: 2.5 },
    }));
    return [...partnerEdges, ...askEdges];
  }, [activeAsks]);

  return (
    <div className="flex-1 h-full" data-testid="canvas">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView>
        <Background gap={20} color="#313244" />
      </ReactFlow>
    </div>
  );
}
