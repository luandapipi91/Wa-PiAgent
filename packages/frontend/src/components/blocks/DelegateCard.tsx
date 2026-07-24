import type { ToolCall, ToolResultMessage } from "@hiagent/shared";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ProcessCard, Spinner } from "./ProcessCard";
import { useAutoCollapse } from "./useAutoCollapse";

interface Props {
  toolCall: ToolCall;
  result?: ToolResultMessage;
  isStreaming?: boolean;
}

/** 委派卡片：流式中展开（任务可见），完成即折叠；子智能体回复用 ReactMarkdown 渲染 */
export function DelegateCard({ toolCall, result, isStreaming }: Props) {
  const args = toolCall.arguments as { agent?: string; task?: string };
  const { open, toggle } = useAutoCollapse({ isStreaming, isDone: !!result });
  const failed = !!result?.isError;
  const full = result?.content.map((c: ToolResultMessage["content"][number]) => (c.type === "text" ? c.text : "")).join("\n") ?? "";
  return (
    <ProcessCard
      tone="warning"
      icon="↪"
      title={`委派给 ${args.agent ?? "子智能体"}`}
      meta={!result ? (<><Spinner /><span>执行中</span></>) : failed ? "✗ 失败" : "✓ 完成"}
      open={open}
      onToggle={toggle}
      muted={!isStreaming}
      testId={`delegate-${toolCall.id}`}
    >
      <div className="mb-1">📋 任务：{args.task}</div>
      {result && (
        <div data-testid="text-block" className={failed ? "text-danger" : ""}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{full}</ReactMarkdown>
        </div>
      )}
    </ProcessCard>
  );
}
