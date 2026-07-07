import { useMemo } from "react";
import ReactFlow, { Background } from "reactflow";
import "reactflow/dist/style.css";
import type { AgentName } from "@hiagent/shared";
import { useAgentsStore } from "../../store/agents";
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
  // 委派展示降级：intercom 旁路系统移除后暂用空对象占位，
  // 后续需求从消息流（DelegateCard/DelegateReceived）重建 ask→edge 映射。
  const asksBySession: Record<string, never[]> = {};

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

  const edges = useMemo(() => {
    // 默认 partners 连线（灰色虚线）
    const partnerEdges = DEFAULT_PARTNERS.map(([f, t]) => ({
      id: `${f}-${t}`,
      source: f,
      target: t,
      style: { stroke: "#6c7086", strokeDasharray: "4,3", strokeWidth: 2 },
    }));
    // 委派 ask 连线降级：asksBySession 暂为空占位，故无橙色动画连线。
    // 后续需求从消息流（DelegateCard/DelegateReceived）重建 ask→edge 映射后再恢复。
    return partnerEdges;
    // asksBySession 保留引用，便于后续重建逻辑直接接入
    void asksBySession;
  }, [asksBySession]);

  return (
    <div className="flex-1 h-full" data-testid="canvas">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView>
        <Background gap={20} color="#313244" />
      </ReactFlow>
    </div>
  );
}
