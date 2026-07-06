import { useMemo } from "react";
import ReactFlow, { Background, Controls } from "reactflow";
import "reactflow/dist/style.css";
import { useAgents } from "../store/agents";
import { useIntercom } from "../store/intercom";
import { CanvasNode } from "./CanvasNode";

const nodeTypes = { agent: CanvasNode };

export function Canvas() {
  const list = useAgents(s => s.list);
  const states = useAgents(s => s.states);
  const asks = useIntercom(s => s.asks);

  const nodes = useMemo(() => {
    const n = list.length || 1;
    return list.map((agent, i) => {
      const angle = (i / n) * 2 * Math.PI;
      return {
        id: agent.name, type: "agent",
        position: { x: 250 + 150 * Math.cos(angle), y: 200 + 120 * Math.sin(angle) },
        data: { agent, state: states[agent.name] },
      };
    });
  }, [list, states]);

  const edges = useMemo(() => {
    const result: any[] = [];
    for (const agent of list) {
      for (const to of agent.partners.askTo) {
        const isActive = asks.some(a => !a.resolved && a.from === agent.name && a.to === to);
        result.push({
          id: `${agent.name}-${to}`, source: agent.name, target: to, animated: isActive,
          style: { stroke: isActive ? "#fab387" : "#6c7086", strokeWidth: isActive ? 2.5 : 2, strokeDasharray: isActive ? "6 4" : "4 3" },
        });
      }
    }
    return result;
  }, [list, asks]);

  return (
    <div className="h-screen w-full">
      <div className="bg-mantle px-2.5 py-1.5 border-b border-surface flex items-center gap-2">
        <span className="font-semibold text-blue text-[12px]">编排画布</span>
        <span className="text-overlay text-[11px]">│ 拖拽添加 agent · 连线表示可通信</span>
      </div>
      <div className="h-[calc(100vh-40px)]">
        <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView>
          <Background color="#313244" gap={20} />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  );
}
