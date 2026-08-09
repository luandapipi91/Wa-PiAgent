import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createMarkdownComponents } from "./markdown-components";
import { useSettled } from "./useSettled";

/**
 * 子代理流式输出渲染（流式卡顿修复 3.3）：
 * - 进行中且未停顿：纯文本预览（whitespace-pre-wrap，与 ThinkingCard 同款低成本渲染），
 *   每 token 重跑 ReactMarkdown/remarkGfm 是 delegate/fleet 场景的卡顿热点；
 * - 停顿 500ms（useSettled）或流式结束：完整 markdown 渲染。
 * memo：props 为基本类型，父组件每帧重渲染时 props 不变则整块跳过。
 */
export const StreamingOutput = memo(function StreamingOutput({
  text,
  sessionId,
  streaming,
  idleMs = 500,
}: {
  text: string;
  sessionId: string;
  /** true = 子代理执行中（progress.output 高频增长） */
  streaming: boolean;
  idleMs?: number;
}) {
  const settled = useSettled(text, idleMs);
  const mdComponents = useMemo(
    () => createMarkdownComponents(sessionId),
    [sessionId],
  );
  if (streaming && !settled) {
    return (
      <div
        data-testid="streaming-output-plain"
        className="whitespace-pre-wrap break-words"
      >
        {text}
      </div>
    );
  }
  return (
    <div data-testid="streaming-output-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
