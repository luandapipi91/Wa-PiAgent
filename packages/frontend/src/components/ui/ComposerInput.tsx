import { useRef, useCallback, useState } from "react";
import type { AttachmentDraft } from "@hiagent/shared";
import { ModelSelector } from "./ModelSelector";
import { ThinkingToggle } from "./ThinkingToggle";
import { AttachmentChip } from "./AttachmentChip";
import { AttachmentPathModal } from "./AttachmentPathModal";

interface Props {
  text: string;
  setText: (text: string) => void;
  model: string | null;
  setModel: (model: string) => void;
  thinking: "disabled" | "high";
  setThinking: (thinking: "disabled" | "high") => void;
  attachments: AttachmentDraft[];
  setAttachments: (attachments: AttachmentDraft[]) => void;
  onSend: () => void;
  sendDisabled?: boolean;
  placeholder?: string;
}

export function ComposerInput({
  text, setText, model, setModel, thinking, setThinking,
  attachments, setAttachments, onSend, sendDisabled, placeholder,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<{ file: File; kind: "image" | "file" } | null>(null);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 300) + "px";
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const kind = file.type.startsWith("image/") ? "image" : "file";
    setPendingFile({ file, kind });
    e.target.value = "";
  };

  const confirmPath = (path: string) => {
    if (!pendingFile) return;
    const { file, kind } = pendingFile;
    setAttachments([...attachments, { kind, name: file.name, path, size: file.size }]);
    setPendingFile(null);
  };

  const removeAttachment = (idx: number) => {
    setAttachments(attachments.filter((_, i) => i !== idx));
  };

  const canSend = !sendDisabled && text.trim();

  return (
    <div className="w-full max-w-[860px] mx-auto" data-testid="composer-input">
      <div className="rounded-2xl bg-surface border border-hairline shadow-md overflow-hidden focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-soft),var(--shadow-md)] transition-all duration-150">
        <textarea
          ref={textareaRef}
          value={text}
          onChange={e => { setText(e.target.value); autoResize(); }}
          onKeyDown={e => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (canSend) onSend();
            }
          }}
          placeholder={placeholder}
          rows={1}
          className="w-full bg-transparent text-primary outline-none resize-none text-sm p-4 placeholder:text-tertiary"
          style={{ maxHeight: 300, overflowY: "auto", minHeight: 60 }}
        />
        <div className="flex items-center justify-between px-3 py-2 border-t border-hairline">
          <div className="flex items-center gap-3">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="text-lg text-secondary hover:text-primary"
              title="添加附件"
            >📎</button>
            <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileSelect} />
            <ModelSelector value={model} onChange={setModel} />
            <ThinkingToggle value={thinking} onChange={setThinking} />
          </div>
          <button
            data-testid="composer-send"
            onClick={onSend}
            disabled={!canSend}
            className="w-8 h-8 rounded-full flex items-center justify-center text-sm flex-shrink-0 transition-transform enabled:hover:scale-105 border-0 cursor-pointer disabled:cursor-not-allowed"
            style={{ background: canSend ? "var(--brand)" : "var(--hairline-strong)", color: "var(--on-brand)" }}
          >↑</button>
        </div>
      </div>
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-2 px-1" data-testid="attachment-list">
          {attachments.map((a, i) => (
            <AttachmentChip key={i} attachment={a} onRemove={() => removeAttachment(i)} />
          ))}
        </div>
      )}
      {pendingFile && (
        <AttachmentPathModal
          fileName={pendingFile.file.name}
          onConfirm={confirmPath}
          onCancel={() => setPendingFile(null)}
        />
      )}
    </div>
  );
}
