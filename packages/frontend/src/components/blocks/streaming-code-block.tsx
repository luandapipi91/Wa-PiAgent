// llm-ui 代码块适配层（流式卡顿修复 3.4）。
// 闭合代码块 → CodeBlockCard（Prism 高亮；其内部 memo 使 code 不变时跳过重渲染）；
// mermaid 闭合块 → MermaidBlock（自带 1000ms 渲染防抖）；
// 未闭合代码块 → 纯 <pre>，不高亮（Prism 每帧全量重跑是流式卡顿热点之一）。
import {
  codeBlockLookBack,
  findCompleteCodeBlock,
  findPartialCodeBlock,
  parseCompleteMarkdownCodeBlock,
  parsePartialMarkdownCodeBlock,
} from "@llm-ui/code";
import type { LLMOutputBlock, LLMOutputComponent } from "@llm-ui/react";
import { CodeBlockCard } from "./CodeBlockCard";
import { MermaidBlock } from "./MermaidBlock";

/** 从代码块原文提取 language + code（llm-ui parse 的纯函数适配层，便于单测）。 */
export function parseStreamingCodeBlock(
  outputRaw: string,
  isComplete: boolean,
): { language: string; code: string } {
  const parsed = isComplete
    ? parseCompleteMarkdownCodeBlock(outputRaw)
    : parsePartialMarkdownCodeBlock(outputRaw);
  return { language: parsed.language ?? "", code: parsed.code ?? "" };
}

const StreamingCodeBlockView: LLMOutputComponent = ({ blockMatch }) => {
  const { language, code } = parseStreamingCodeBlock(
    blockMatch.outputRaw,
    blockMatch.isComplete,
  );
  if (!blockMatch.isComplete) {
    return (
      <pre
        data-testid="streaming-code-plain"
        className="text-[calc(12px*var(--font-scale))] p-3 overflow-x-auto my-1 rounded-lg border border-hairline m-0 whitespace-pre-wrap break-words"
        style={{ background: "var(--surface)" }}
      >
        {code}
      </pre>
    );
  }
  if (language === "mermaid") return <MermaidBlock code={code} />;
  return <CodeBlockCard language={language} code={code} />;
};

/** 构造 llm-ui 代码块配置（工厂：每次调用新建 matcher，避免跨组件共享正则 lastIndex 状态）。 */
export function createStreamingCodeBlock(): LLMOutputBlock {
  return {
    findCompleteMatch: findCompleteCodeBlock(),
    findPartialMatch: findPartialCodeBlock(),
    lookBack: codeBlockLookBack(),
    component: StreamingCodeBlockView,
  };
}
