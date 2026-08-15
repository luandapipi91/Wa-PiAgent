import { useRef, useEffect, useCallback } from "react";
import { textToHtml, ensureChipStyles } from "../../quick-invoke/tokens";

interface Props {
  text: string;
  onTextChange: (text: string) => void;
  placeholder?: string;
  disabled?: boolean;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onPaste: (e: React.ClipboardEvent<HTMLDivElement>) => void;
  /** 自定义 token→HTML 渲染（默认聊天 tokens 的 textToHtml；自动化编辑器传联系人 chip 版） */
  toHtml?: (text: string) => string;
  /** 透传 data-testid（自动化编辑器 e2e 定位用） */
  testId?: string;
}

/**
 * 从 contenteditable DOM 提取纯文本 token 字符串。
 * chip span 取 data-token 属性，普通文本取 textContent。
 *
 * 换行处理：contenteditable 按 Enter，浏览器不会插入 \n 文本节点，
 * 而是插入 <div>/<p> 块元素（Chrome 默认）或 <br>（Shift+Enter / Firefox）。
 * 必须把这些块节点转回 \n，否则多行内容发送时换行丢失。
 */
const BLOCK_TAGS = new Set(["DIV", "P", "BR", "LI", "TR", "BLOCKQUOTE", "H1", "H2", "H3", "H4", "H5", "H6", "PRE"]);

function extractText(el: HTMLElement): string {
  let result = "";
  const childNodes = Array.from(el.childNodes);
  for (let idx = 0; idx < childNodes.length; idx++) {
    const node = childNodes[idx];
    if (node.nodeType === Node.TEXT_NODE) {
      result += node.textContent ?? "";
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const elem = node as HTMLElement;
      const tag = elem.tagName;
      const token = elem.getAttribute("data-token");
      if (token) {
        // chip 前若是块元素结束（result 以 \n 结尾或为空）无需补换行；
        // 否则 chip 作为行内元素，原样拼接 token。
        result += token;
      } else if (tag === "BR") {
        result += "\n";
      } else {
        // 块级元素：仅在内容前补一个换行作为行分隔（块与块之间、文本与块之间），
        // 块后不补 —— 避免发送时末尾多出空行（用户在末尾按回车产生的 <br> 仍会保留为 \n）。
        const isBlock = BLOCK_TAGS.has(tag);
        if (isBlock && result.length > 0 && !result.endsWith("\n")) {
          // 例外：前一个兄弟节点是 chip（inline 元素，带 data-token）时，
          // 当前块元素是 Chrome contenteditable 把"chip 后同行文字"包进 <div> 的产物，
          // 并非用户按 Enter 产生的真正换行 → 不补 \n（否则 chip 和后续文字被拆成两行）。
          const prev = childNodes[idx - 1];
          const prevIsChip = prev?.nodeType === Node.ELEMENT_NODE
            && !!(prev as HTMLElement).getAttribute("data-token");
          if (!prevIsChip) {
            result += "\n";
          }
        }
        result += extractText(elem);
      }
    }
  }
  return result;
}

/**
 * contenteditable 输入框，支持内联 chip 渲染。
 * 采用半受控模式：text 作为目标值，仅在 DOM 与 text 不一致时同步 DOM。
 */
export function ComposerTextarea({
  text, onTextChange, placeholder, disabled, onKeyDown, onPaste, toHtml, testId,
}: Props) {
  ensureChipStyles();
  const elRef = useRef<HTMLDivElement>(null);
  const render = toHtml ?? textToHtml;

  // 半受控同步：仅在 text 与 DOM 当前内容不一致时更新 DOM（如外部清空 / chip 插入）
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const currentText = extractText(el);
    if (currentText !== text) {
      el.innerHTML = render(text);
      // innerHTML 替换后浏览器会把光标重置到开头；移到末尾符合"插入后继续输入"的预期
      // （仅在外部 setText 触发的同步路径，handleInput 路径不会进这里因为 currentText === text）
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);   // collapse to end
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      el.focus();
    }
  }, [text, render]);

  const handleInput = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    onTextChange(extractText(el));
  }, [onTextChange]);

  return (
    <div
      ref={elRef}
      role="textbox"
      contentEditable={!disabled}
      suppressContentEditableWarning
      onInput={handleInput}
      onKeyDown={onKeyDown}
      onPaste={onPaste}
      data-testid={testId}
      data-placeholder={placeholder}
      className="w-full bg-transparent text-primary outline-none resize-none text-sm px-4 py-4 placeholder:text-tertiary overflow-y-auto"
      style={{ maxHeight: 300, minHeight: 60, whiteSpace: "pre-wrap", wordBreak: "break-word" }}
    />
  );
}
