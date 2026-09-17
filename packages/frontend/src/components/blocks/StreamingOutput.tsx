import { memo, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createMarkdownComponents } from "./markdown-components";
import { useThrottledValue } from "./useThrottledValue";

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
  throttleMs = 50,
}: {
  text: string;
  sessionId: string;
  /** true = 子代理执行中（progress.output 高频增长） */
  streaming: boolean;
  throttleMs?: number;
}) {
  // 流式渲染节流（终版，替代 plain↔md 停顿降级——同主回复闪烁根因）：
  // 流式中始终 markdown，解析节流 idleMs；结束后零延迟同步。
  const displayText = useThrottledValue(text, streaming, throttleMs);
  const mdComponents = useMemo(
    () => createMarkdownComponents(sessionId),
    [sessionId],
  );
  return (
    <div data-testid="streaming-output-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
        {displayText}
      </ReactMarkdown>
    </div>
  );
});
