import { useRef, useCallback, useState } from "react";
import type { AttachmentDraft, ThinkingLevel } from "@hiagent/shared";
import { uploadFile, copyToUploads } from "../../fs-client";
import { useProjectsStore } from "../../store/projects";
import { ModelSelector } from "./ModelSelector";
import { ThinkingSelector } from "./ThinkingSelector";
import { AttachmentChip } from "./AttachmentChip";
import { FilePicker, type FilePickerSelection } from "./FilePicker";

interface Props {
  text: string;
  setText: (text: string) => void;
  model: string | null;
  setModel: (model: string) => void;
  thinking: ThinkingLevel;
  setThinking: (thinking: ThinkingLevel) => void;
  attachments: AttachmentDraft[];
  setAttachments: (value: AttachmentDraft[] | ((prev: AttachmentDraft[]) => AttachmentDraft[])) => void;
  projectId?: string;
  onSend: () => void;
  sendDisabled?: boolean;
  placeholder?: string;
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const base64 = result.includes(",") ? result.split(",")[1] : result;
      resolve(base64);
    };
    reader.onerror = () => reject(new Error("读取文件失败"));
    reader.readAsDataURL(file);
  });
}

export function ComposerInput({
  text, setText, model, setModel, thinking, setThinking,
  attachments, setAttachments, projectId, onSend, sendDisabled, placeholder,
}: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingUploads, setPendingUploads] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const uploading = pendingUploads > 0;
  // 附件选择器默认定位到当前项目目录（cwd），方便就近选取项目内文件
  const projectCwd = useProjectsStore(s => s.projects.find(p => p.id === projectId)?.cwd);

  const isImageName = (name: string) => /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i.test(name);

  const addAttachment = (draft: AttachmentDraft) => {
    setAttachments(prev => [...prev, draft]);
  };

  const handlePick = async (selections: FilePickerSelection[]) => {
    if (!projectId || selections.length === 0) return;
    setUploadError(null);
    setPendingUploads(n => n + selections.length);
    for (const sel of selections) {
      try {
        const { path } = await copyToUploads(projectId, sel.path);
        const kind = sel.isDir ? "folder" : isImageName(sel.name) ? "image" : "file";
        addAttachment({ kind, name: sel.name, path, size: 0 } as AttachmentDraft);
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : "添加附件失败");
      } finally {
        setPendingUploads(n => n - 1);
      }
    }
    setPickerOpen(false);
  };

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 300) + "px";
  }, []);

  const uploadFiles = async (files: FileList | null) => {
    if (!files || files.length === 0 || !projectId) return;
    const list = Array.from(files);
    setUploadError(null);
    setPendingUploads(n => n + list.length);
    for (const file of list) {
      try {
        const content = await readFileAsBase64(file);
        const { path } = await uploadFile(projectId, file.name, content);
        const kind = file.type.startsWith("image/") ? "image" : "file";
        setAttachments(prev => [...prev, { kind, name: file.name, path, size: file.size }]);
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : "上传失败");
      } finally {
        setPendingUploads(n => n - 1);
      }
    }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    void uploadFiles(e.target.files);
    e.target.value = "";
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = e.clipboardData.files;
    if (files.length > 0) {
      e.preventDefault();
      void uploadFiles(files);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    void uploadFiles(e.dataTransfer.files);
  };

  const removeAttachment = (idx: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== idx));
  };

  const canSend = !sendDisabled && text.trim() && model !== null;

  return (
    <div className="w-full max-w-[860px] mx-auto" data-testid="composer-input">
      <div
        className="rounded-2xl bg-surface border border-hairline shadow-md overflow-hidden focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-soft),var(--shadow-md)] transition-all duration-150"
        onDragOver={e => e.preventDefault()}
        onDrop={handleDrop}
      >
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
          onPaste={handlePaste}
          placeholder={placeholder}
          rows={1}
          className="w-full bg-transparent text-primary outline-none resize-none text-sm p-4 placeholder:text-tertiary"
          style={{ maxHeight: 300, overflowY: "auto", minHeight: 60 }}
        />
        <div className="flex items-center justify-between px-3 py-2 border-t border-hairline">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setPickerOpen(true)}
              disabled={uploading}
              className="text-lg text-secondary hover:text-primary disabled:opacity-50"
              title="添加附件"
            >📎</button>
            <input ref={fileInputRef} type="file" className="hidden" onChange={handleFileSelect} />
            {pickerOpen && projectId && (
              <FilePicker
                onPick={handlePick}
                onCancel={() => setPickerOpen(false)}
                multiSelect
                defaultPath={projectCwd}
              />
            )}
            <ModelSelector value={model} onChange={setModel} />
            <ThinkingSelector value={thinking} onChange={setThinking} />
            {uploading && <span className="text-xs text-tertiary" data-testid="upload-spinner">上传中...</span>}
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
      {uploadError && (
        <div className="text-xs text-danger mt-2 px-1" data-testid="upload-error">{uploadError}</div>
      )}
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-2 mt-2 px-1" data-testid="attachment-list">
          {attachments.map((a, i) => (
            <AttachmentChip key={i} attachment={a} onRemove={() => removeAttachment(i)} />
          ))}
        </div>
      )}
    </div>
  );
}
