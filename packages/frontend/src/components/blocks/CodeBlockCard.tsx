import { memo, useState } from "react";
import { Highlight, themes } from "prism-react-renderer";
import { useToastStore } from "../../store/toast";
import { copyToClipboard } from "../../util/clipboard";

const COLLAPSE_LINES = 20;

/** cocode 式代码块卡片：头部条（语言名 + 复制），Prism 高亮 + 行号，超 20 行可折叠 */
// memo：props 为字符串，流式期间已定稿的代码块跳过重渲染（Prism 高亮是流式卡顿热点之一）
export const CodeBlockCard = memo(function CodeBlockCard({ language, code }: { language: string; code: string }) {
  const [expanded, setExpanded] = useState(false);
  const addToast = useToastStore(s => s.add);
  const lines = code.replace(/\n$/, "").split("\n");
  const collapsible = lines.length > COLLAPSE_LINES;
  const shown = collapsible && !expanded ? lines.slice(0, COLLAPSE_LINES).join("\n") : lines.join("\n");
  const lang = language || "text";

  const copy = async () => {
    try {
      await copyToClipboard(code);
      addToast("已复制到剪贴板", "success");
    } catch {
      addToast("复制失败", "error");
    }
  };

  return (
    <div data-testid="code-block-card" className="rounded-lg border border-hairline overflow-hidden my-1">
      <div className="flex items-center px-2.5 py-1 bg-surface-elevated border-b border-hairline">
        <span className="text-[calc(11px*var(--font-scale))] font-mono text-tertiary">{lang}</span>
        <button
          type="button"
          data-testid="code-copy"
          onClick={copy}
          className="ml-auto text-[calc(11px*var(--font-scale))] text-tertiary hover:text-primary transition-colors"
          style={{ cursor: "pointer" }}
        >
          复制
        </button>
      </div>
      <Highlight theme={themes.github} code={shown} language={lang}>
        {({ tokens, getLineProps, getTokenProps }) => (
          <pre className="text-[calc(12px*var(--font-scale))] p-3 overflow-x-auto m-0" style={{ background: "var(--surface)" }}>
            {tokens.map((line, i) => (
              <div key={i} {...getLineProps({ line })}>
                <span className="inline-block w-8 text-right mr-3 text-tertiary select-none">{i + 1}</span>
                {line.map((token, k) => (
                  <span key={k} {...getTokenProps({ token })} />
                ))}
              </div>
            ))}
          </pre>
        )}
      </Highlight>
      {collapsible && (
        <button
          type="button"
          data-testid="code-expand"
          onClick={() => setExpanded(e => !e)}
          className="w-full text-center text-[calc(11px*var(--font-scale))] text-tertiary hover:text-primary py-1 border-t border-hairline bg-surface-elevated transition-colors"
          style={{ cursor: "pointer" }}
        >
          {expanded ? "收起" : `+${lines.length - COLLAPSE_LINES} more lines`}
        </button>
      )}
    </div>
  );
});
