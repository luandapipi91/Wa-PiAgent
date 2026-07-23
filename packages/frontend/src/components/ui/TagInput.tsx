import { useRef, useState, type KeyboardEvent, type ChangeEvent } from "react";
import { splitModelIds } from "@hiagent/shared";

interface TagInputProps {
  value: string[];              // 当前 tags（= 模型 ID 列表）
  onChange: (tags: string[]) => void;
  placeholder?: string;
  /** 可选下拉内容，渲染在 input 下方 */
  dropdown?: React.ReactNode;
  /** input 文本变化回调（用于外部过滤下拉等） */
  onInputText?: (text: string) => void;
}

/** 通用 tag 录入：输入 | 添加（分隔即 flush），回车提交，× 移除 */
export function TagInput({ value, onChange, placeholder, dropdown, onInputText }: TagInputProps) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // 输入变化：若含 |，把 | 前的部分加入 tags，| 后的剩余留输入框继续
  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const newText = e.target.value;
    // 含分隔符才 flush（避免每次输入都解析）
    if (!newText.includes("|")) {
      setText(newText);
      onInputText?.(newText);
      return;
    }
    // 拆分：最后一个 | 之前的都成 tag，之后的是新的输入框内容
    const ids = splitModelIds(newText);
    if (ids.length > 0) {
      onChange([...value, ...ids]);
    }
    // splitModelIds 已吃掉所有 | 分隔的部分；残留的纯文本无 |
    setText("");
    onInputText?.("");
  };

  // 回车：提交整个输入框文本为一个 tag
  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const trimmed = text.trim();
      if (trimmed) {
        onChange([...value, trimmed]);
        setText("");
        onInputText?.("");
      }
    }
  };

  // 移除指定 tag
  const removeTag = (index: number) => {
    onChange(value.filter((_, i) => i !== index));
  };

  return (
    <div className="relative">
    <div
      className="flex flex-wrap items-center gap-1.5 px-2 py-1.5 rounded-sm border border-hairline bg-surface"
      data-testid="tag-input"
      onClick={() => inputRef.current?.focus()}
    >
      {value.map((tag, i) => (
        <span
          key={`${tag}-${i}`}
          className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs"
          style={{ background: "var(--surface-hover)", color: "var(--primary)" }}
        >
          {tag}
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); removeTag(i); }}
            className="text-tertiary hover:text-danger"
            data-testid="tag-remove"
          >×</button>
        </span>
      ))}
      <input
        ref={inputRef}
        type="text"
        value={text}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder={value.length === 0 ? placeholder : ""}
        className="flex-1 min-w-[120px] bg-transparent border-0 outline-none text-sm text-primary"
        data-testid="tag-input-field"
      />
    </div>
    {dropdown}
    </div>
  );
}
