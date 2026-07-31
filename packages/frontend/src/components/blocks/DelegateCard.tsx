import { useState } from "react";
import type { ToolCall, ToolResultMessage } from "@wa-pi/shared";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ProcessCard, Spinner } from "./ProcessCard";
import { useAutoCollapse } from "./useAutoCollapse";
import { createMarkdownComponents } from "./markdown-components";
import { useSessionStore } from "../../store/session";

interface Props {
  sessionId: string;
  toolCall: ToolCall;
  result?: ToolResultMessage;
  isStreaming?: boolean;
}

// 子代理状态文案映射：SubagentProgressEvent.status → 中文展示
function statusLabel(status: string): string {
  if (status === "running") return "运行中";
  if (status === "done") return "完成";
  return "出错";
}

/** 委派卡片：流式中展开（任务可见），完成即折叠；子智能体回复用 ReactMarkdown 渲染。
 *  有实时进度（progress）时：始终显示一行摘要（状态/耗时/工具数）+ ▶/▼ 开关，
 *  展开后看实时 output 与工具时间线；完成态也保持折叠一致——展开才看结果详情。 */
export function DelegateCard({ sessionId, toolCall, result, isStreaming }: Props) {
  const args = toolCall.arguments as { agent?: string; task?: string };
  const { open: autoOpen, toggle } = useAutoCollapse({ isStreaming, isDone: !!result, executingMode: true });

  // 子代理进度：Task 8 为二级 map（[toolCallId][agent]），delegate 单 agent 取内层首项。
  const agentMap = useSessionStore((s) => s.progressByToolCall[toolCall.id]);
  const progress = agentMap ? Object.values(agentMap)[0] : undefined;

  // 有进度时摘要行需始终可见：强制外层卡片展开，进度详情由 progressExpanded 独立控制。
  const [progressExpanded, setProgressExpanded] = useState(false);
  const hasProgress = !!progress;
  const open = hasProgress || autoOpen;

  const failed = !!result?.isError;
  const full = result?.content.map((c: ToolResultMessage["content"][number]) => (c.type === "text" ? c.text : "")).join("\n") ?? "";
  const mdComponents = createMarkdownComponents(sessionId);
  return (
    <ProcessCard
      tone="warning"
      icon="↪"
      title={`委派给 ${args.agent ?? "子智能体"}`}
      meta={!result ? (<><Spinner /><span>执行中</span></>) : failed ? "✗ 失败" : "✓ 完成"}
      open={open}
      onToggle={toggle}
      muted={!!result}
      testId={`delegate-${toolCall.id}`}
    >
      <div className="mb-1">📋 任务：{args.task}</div>
      {hasProgress && (
        <div className="mt-2 pt-2 border-t border-hairline" data-testid={`delegate-progress-${toolCall.id}`}>
          {/* 摘要行：始终可见，点击切换进度详情（独立于卡片整体展开） */}
          <button
            type="button"
            aria-label={progressExpanded ? "折叠" : "展开"}
            onClick={() => setProgressExpanded((v) => !v)}
            className="w-full flex items-center gap-1.5 text-[11px] text-tertiary py-1"
            style={{ cursor: "pointer" }}
          >
            <span>子智能体 · {statusLabel(progress!.status)} · {Math.round(progress!.elapsedMs / 1000)}s · {progress!.tools.length} 个工具</span>
            <span className="ml-auto">{progressExpanded ? "▼" : "▶"}</span>
          </button>
          {progressExpanded && (
            <div className="mt-1 min-w-0">
              {/* 实时 output：可滚动 pre，避免长文本撑爆卡片 */}
              {progress!.output && (
                <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-bg px-2 py-1 text-[11px] text-secondary mb-1">{progress!.output}</pre>
              )}
              {/* 工具时间线：名称 + 状态 */}
              {progress!.tools.length > 0 && (
                <ul className="text-[11px] text-tertiary space-y-0.5 mb-1">
                  {progress!.tools.map((t) => (
                    <li key={t.id}>{t.name} · {t.status}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
      {/* 结果详情：仅进度详情展开时显示（与折叠一致的全生命周期约束） */}
      {result && (!hasProgress || progressExpanded) && (
        <div data-testid="text-block" className={`mt-2 pt-2 border-t border-hairline ${failed ? "text-danger" : ""}`}>
          <div className="text-[11px] text-tertiary mb-1">📤 回复：</div>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{full}</ReactMarkdown>
        </div>
      )}
    </ProcessCard>
  );
}
