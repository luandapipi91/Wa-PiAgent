// 流式进行中的 markdown 渲染（流式卡顿修复 3.4）——llm-ui 分块：
// 闭合代码块拆出为独立组件（code 引用稳定 + memo → 不再每帧全量 Prism）；
// 未闭合代码块纯 <pre>；markdown fallback 复用现有自定义组件（FilePill/MarkdownLink）。
// markdownLookBack 扣留未闭合的行内 markdown 尾巴（闭合后才显示），不参与解析。
// 定稿后由 MessageRow 切回原 MarkdownBlock（本组件只服务流式阶段）。
import { memo, useMemo } from "react";
import { useLLMOutput } from "@llm-ui/react";
import type { BlockMatch } from "@llm-ui/react";
import { markdownLookBack } from "@llm-ui/markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { createMarkdownComponents } from "./markdown-components";
import { createStreamingCodeBlock } from "./streaming-code-block";

export const StreamingMarkdown = memo(function StreamingMarkdown({
  text,
  sessionId,
}: {
  text: string;
  sessionId: string;
}) {
  const mdComponents = useMemo(
    () => createMarkdownComponents(sessionId),
    [sessionId],
  );
  // blocks/fallbackBlock 引用须稳定（随 mdComponents 变才重建），否则 useLLMOutput 每帧重匹配
  const blocks = useMemo(() => [createStreamingCodeBlock()], []);
  const fallbackBlock = useMemo(
    () => ({
      lookBack: markdownLookBack(),
      component: ({ blockMatch }: { blockMatch: BlockMatch }) => (
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>
          {blockMatch.output}
        </ReactMarkdown>
      ),
    }),
    [mdComponents],
  );
  const { blockMatches } = useLLMOutput({
    llmOutput: text,
    isStreamFinished: false,
    blocks,
    fallbackBlock,
  });
  return (
    <div className="prose prose-sm max-w-none" data-testid="text-block">
      {blockMatches.map((m, i) => {
        const C = m.block.component as any;
        return <C key={i} blockMatch={m} />;
      })}
    </div>
  );
});
