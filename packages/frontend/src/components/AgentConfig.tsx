// PLACEHOLDER — Task 26 将实现真正的 AgentConfig（agent 配置弹窗）。
// 此占位仅为让 App.tsx（Task 21）中 AgentConfig 引用可编译/通过测试；
// 当 Task 26 落地时整体替换本文件。
import type { AgentName } from "@hiagent/shared";

interface Props {
  agentName: AgentName;
  onClose: () => void;
}

export function AgentConfig({ agentName, onClose }: Props) {
  return (
    <div className="flex flex-col" data-testid="agent-config">
      <p className="text-subtext">Agent 配置（占位）· {agentName}</p>
      <button onClick={onClose} data-testid="agent-config-close">关闭</button>
    </div>
  );
}
