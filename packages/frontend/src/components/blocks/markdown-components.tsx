import type { Components } from "react-markdown";
import { CodeBlockCard } from "./CodeBlockCard";
import { MermaidBlock } from "./MermaidBlock";
import { FilePill } from "./FilePill";
import { parseFilePath } from "./file-path";

// ⚠️ 循环依赖：FileViewer → markdown-components → FilePill → FileViewer。
// 约束：本模块顶层不得引用 FileViewer/FilePill 的模块级值（如初始化、常量推导）；
// 组件引用只在渲染期访问（JSX 内），函数声明提升 + 渲染期才求值保证安全。
// 新增代码时保持同样约束：不要在任何顶层作用域调用 FileViewer/FilePill。

/**
 * markdown 链接渲染：新标签页打开，避免 SPA 页面被外部链接替换；
 * 蓝色 + 下划线样式，让用户一眼看出可点击。
 * 导出供所有 ReactMarkdown 渲染点（聊天区 / fleet / delegate / ask 选项 preview）复用。
 */
export function MarkdownLink({ className, ...props }: any) {
  return (
    <a
      {...props}
      target="_blank"
      rel="noopener noreferrer"
      className={`text-accent underline underline-offset-2 hover:opacity-80 ${className ?? ""}`.trim()}
    />
  );
}

/**
 * 生成助手消息的 markdown 组件映射。
 * pre → CodeBlockCard / MermaidBlock；形似路径的内联 code → FilePill（块级 code 已被 pre 接管，不会走到这里）；a → 新标签页打开。
 */
export function createMarkdownComponents(sessionId: string): Components {
  return {
    a: MarkdownLink,
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
