import { useRef, useEffect, useCallback } from "react";
import { textToHtml, ensureChipStyles } from "../../quick-invoke/tokens";

interface Props {
  text: string;
  onTextChange: (text: string) => void;
  placeholder?: string;
  disabled?: boolean;
  onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => void;
  onPaste: (e: React.ClipboardEvent<HTMLDivElement>) => void;
}

/**
 * 从 contenteditable DOM 提取纯文本 token 字符串。
 * chip span 取 data-token 属性，普通文本取 textContent。
 */
function extractText(el: HTMLElement): string {
  let result = "";
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      result += node.textContent ?? "";
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const elem = node as HTMLElement;
      const token = elem.getAttribute("data-token");
      if (token) {
        result += token;
      } else {
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
  text, onTextChange, placeholder, disabled, onKeyDown, onPaste,
}: Props) {
  ensureChipStyles();
  const elRef = useRef<HTMLDivElement>(null);

  // 半受控同步：仅在 text 与 DOM 当前内容不一致时更新 DOM（如外部清空 / chip 插入）
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const currentText = extractText(el);
    if (currentText !== text) {
      el.innerHTML = textToHtml(text);
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
  }, [text]);

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
      data-placeholder={placeholder}
      className="w-full bg-transparent text-primary outline-none resize-none text-sm px-4 py-4 placeholder:text-tertiary overflow-y-auto"
      style={{ maxHeight: 300, minHeight: 60, whiteSpace: "pre-wrap", wordBreak: "break-word" }}
    />
  );
}
