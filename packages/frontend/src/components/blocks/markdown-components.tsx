import type { Components } from "react-markdown";
import { CodeBlockCard } from "./CodeBlockCard";
import { MermaidBlock } from "./MermaidBlock";
import { FilePill } from "./FilePill";
import { parseFilePath } from "./file-path";

/**
 * 生成助手消息的 markdown 组件映射。
 * pre → CodeBlockCard / MermaidBlock；形似路径的内联 code → FilePill（块级 code 已被 pre 接管，不会走到这里）。
 */
export function createMarkdownComponents(sessionId: string): Components {
  return {
    pre: (props: any) => {
      const codeEl = props.children;
      const className: string = codeEl?.props?.className ?? "";
      const m = /language-([\w+-]+)/.exec(className);
      const code = String(codeEl?.props?.children ?? "");
      // mermaid 代码块用 MermaidBlock 渲染为可视图表
      if (m?.[1] === "mermaid") {
        return <MermaidBlock code={code} />;
      }
      return <CodeBlockCard language={m?.[1] ?? ""} code={code} />;
    },
    code: (props: any) => {
      const text = String(props.children ?? "");
      if (!props.className && parseFilePath(text)) {
        return <FilePill rawText={text} sessionId={sessionId} />;
      }
      return <code>{props.children}</code>;
    },
  };
}
