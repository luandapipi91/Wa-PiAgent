import type { ToolCall, ToolResultMessage } from "@hiagent/shared";
import { ProcessCard, Spinner } from "./ProcessCard";
import { useAutoCollapse } from "./useAutoCollapse";

/** 格式化工具调用参数 — 截断长值避免撑爆 UI（自 MessageList 迁入） */
export function formatArgs(args: Record<string, any>): string {
  const keys = Object.keys(args);
  if (keys.length === 0) return "";
  const parts = keys.map(k => {
    const v = args[k];
    if (typeof v === "string") {
      return v.length > 60 ? `${k}: "${v.slice(0, 50)}..."` : `${k}: "${v}"`;
    }
    const s = JSON.stringify(v);
    return s.length > 80 ? `${k}: ${s.slice(0, 77)}...` : `${k}: ${s}`;
  });
  return parts.join(", ");
}

/** 单个工具调用卡片：完成即折叠；成功绿 / 失败红 / 执行中 accent */
export function ToolCallCard({ toolCall, result, isStreaming }: { toolCall: ToolCall; result?: ToolResultMessage; isStreaming?: boolean }) {
  const { open, toggle } = useAutoCollapse({ isStreaming, isDone: !!result });
  const failed = !!result?.isError;
  const tone = !result ? "accent" : failed ? "danger" : "success";
  const name = toolCall.name === "ask_user_question" ? "问答" : toolCall.name;
  return (
    <ProcessCard
      tone={tone}
      icon={!result ? "🔧" : failed ? "✗" : "✓"}
      title={<span className="font-mono">{name} <span className="text-tertiary">({formatArgs(toolCall.arguments)})</span></span>}
      meta={!result ? <Spinner /> : failed ? "失败" : "完成"}
      open={open}
      onToggle={toggle}
      muted={!isStreaming}
      testId={`toolcall-${toolCall.id}`}
    >
      <div className="font-mono whitespace-pre-wrap">{JSON.stringify(toolCall.arguments, null, 2)}</div>
      {result && (
        <div className={`mt-1 pt-1 border-t border-hairline ${failed ? "text-danger" : "text-success"}`}>
          {result.content.map((c: any, i: number) => c.type === "text" && <div key={i}>{c.text}</div>)}
        </div>
      )}
    </ProcessCard>
  );
}

/** 工具调用分组：>1 个连续调用归成一张组卡；单工具直接渲染单卡 */
export function ToolGroupCard({ toolCalls, results, isStreaming }: { toolCalls: any[]; results: Map<string, ToolResultMessage>; isStreaming?: boolean }) {
  if (toolCalls.length === 1) {
    return <ToolCallCard toolCall={toolCalls[0]} result={results.get(toolCalls[0].id)} isStreaming={isStreaming} />;
  }
  return <ToolGroupCardInner toolCalls={toolCalls} results={results} isStreaming={isStreaming} />;
}

function ToolGroupCardInner({ toolCalls, results, isStreaming }: { toolCalls: any[]; results: Map<string, ToolResultMessage>; isStreaming?: boolean }) {
  const total = toolCalls.length;
  const doneCount = toolCalls.filter((tc: any) => results.has(tc.id)).length;
  const successCount = toolCalls.filter((tc: any) => { const r = results.get(tc.id); return r && !r.isError; }).length;
  const failedCount = toolCalls.filter((tc: any) => { const r = results.get(tc.id); return r && r.isError; }).length;
  const { open, toggle } = useAutoCollapse({ isStreaming, isDone: doneCount === total });

  const status: string[] = [];
  if (successCount > 0) status.push(`✓${successCount}`);
  if (failedCount > 0) status.push(`✗${failedCount}`);
  if (doneCount < total) status.push(`⏳${total - doneCount}`);

  return (
    <ProcessCard
      tone="accent"
      icon="🔧"
      title={`${total} 个工具调用`}
      meta={doneCount < total && isStreaming ? (<><Spinner /><span>{status.join(" ")}</span></>) : status.join(" ")}
      open={open}
      onToggle={toggle}
      muted={!isStreaming}
      testId="toolcall-group"
    >
      <div className="space-y-1.5">
        {toolCalls.map((tc: any) => (
          <ToolCallCard key={tc.id} toolCall={tc} result={results.get(tc.id)} isStreaming={isStreaming} />
        ))}
      </div>
    </ProcessCard>
  );
}
