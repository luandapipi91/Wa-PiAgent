import type { Components } from "react-markdown";
import { CodeBlockCard } from "./CodeBlockCard";

/**
 * 生成助手消息的 markdown 组件映射。
 * pre → CodeBlockCard（react-markdown 中代码块结构为 pre > code.language-x）。
 * sessionId 供 Task 5 的 FilePill 解析相对路径用。
 */
export function createMarkdownComponents(sessionId: string): Components {
  return {
    pre: (props: any) => {
      const codeEl = props.children;
      const className: string = codeEl?.props?.className ?? "";
      const m = /language-([\w+-]+)/.exec(className);
      const code = String(codeEl?.props?.children ?? "");
      return <CodeBlockCard language={m?.[1] ?? ""} code={code} />;
    },
  };
}
