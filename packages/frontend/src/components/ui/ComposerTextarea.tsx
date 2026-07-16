import { useRef, useEffect, useCallback } from "react";
import { textToHtml } from "../../quick-invoke/tokens";

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

// chip 内联样式（避免依赖外部 CSS 文件，确保 chip 颜色一致）
let chipStyleInjected = false;
function ensureChipStyles() {
  if (chipStyleInjected || typeof document === "undefined") return;
  chipStyleInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    .chip {
      display: inline-flex;
      align-items: center;
      padding: 1px 6px;
      border-radius: 6px;
      font-size: 0.85em;
      font-weight: 500;
      margin: 0 1px;
      vertical-align: baseline;
      user-select: all;
    }
    .chip-file {
      background-color: #EB933E20;
      color: #EB933E;
      border: 1px solid #EB933E40;
    }
    .chip-skill {
      background-color: #5B5BD620;
      color: #5B5BD6;
      border: 1px solid #5B5BD640;
    }
    [contenteditable][data-placeholder]:empty::before {
      content: attr(data-placeholder);
      color: var(--text-tertiary, #A1A1A6);
      pointer-events: none;
    }
  `;
  document.head.appendChild(style);
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

  // 半受控同步：仅在 text 与 DOM 当前内容不一致时更新 DOM（如外部清空）
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const currentText = extractText(el);
    if (currentText !== text) {
      el.innerHTML = textToHtml(text);
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
