import { memo } from "react";
import { Markdown } from "./Markdown";

/**
 * 子代理流式输出渲染：渲染交给统一组件 blocks/Markdown（它内部做解析节流），
 * 本组件只负责「流式中 = 节流、结束后零延迟」这一层语义与 memo 跳过。
 * memo：props 为基本类型，父组件每帧重渲染时 props 不变则整块跳过。
 */
export const StreamingOutput = memo(function StreamingOutput({
  text,
  sessionId,
  streaming,
  throttleMs = 20,
}: {
  text: string;
  sessionId: string;
  /** true = 子代理执行中（progress.output 高频增长） */
  streaming: boolean;
  throttleMs?: number;
}) {
  // 流式渲染节流交给统一组件（流式中始终 markdown，解析节流；结束后零延迟同步）
  return (
    <Markdown
      text={text}
      sessionId={sessionId}
      streaming={streaming}
      throttleMs={throttleMs}
      className=""
      testId="streaming-output-md"
    />
  );
});
