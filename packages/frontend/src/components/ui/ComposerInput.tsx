import { useRef, useCallback, useState, useEffect, useMemo } from "react";
import type { AttachmentDraft, ThinkingLevel } from "@hiagent/shared";
import { uploadFile, copyToUploads, searchFilesStream } from "../../fs-client";
import { useProjectsStore } from "../../store/projects";
import { useSkillsStore } from "../../store/skills";
import { ModelSelector } from "./ModelSelector";
import { ThinkingSelector } from "./ThinkingSelector";
import { AttachmentChip } from "./AttachmentChip";
import { FilePicker, type FilePickerSelection } from "./FilePicker";
import { RecordButton } from "./RecordButton";
import { ComposerTextarea } from "./ComposerTextarea";
import { QuickInvokeMenu, type MenuItem } from "./QuickInvokeMenu";
import { detectTrigger, filterItems, type TriggerResult } from "../../quick-invoke/trigger";

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
  sessionId: string;
  onSend: () => void;
  sendDisabled?: boolean;
  disabled?: boolean;
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
  attachments, setAttachments, projectId, sessionId, onSend, sendDisabled, disabled, placeholder,
}: Props) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingUploads, setPendingUploads] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const uploading = pendingUploads > 0;
  // 附件选择器默认定位到当前项目目录（cwd），方便就近选取项目内文件
  const projectCwd = useProjectsStore(s => s.projects.find(p => p.id === projectId)?.cwd);

  // === Quick Invoke 状态 ===
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const [fileResults, setFileResults] = useState<MenuItem[]>([]);
  const [dismissed, setDismissed] = useState(false);
  const cancelSearchRef = useRef<(() => void) | null>(null);

  const allSkills = useSkillsStore(s => s.allSkills);

  // 检测当前 text 的触发状态
  const trigger: TriggerResult | null = useMemo(() => detectTrigger(text), [text]);

  // 触发类型
  const triggerType = trigger?.type ?? null;

  // text 变化时重置 dismissed（让面板有机会在新一次触发时再次出现）
  useEffect(() => { setDismissed(false); }, [text]);

  // 文件搜索：@ 触发且有 projectCwd 时调用 searchFilesStream
  useEffect(() => {
    if (triggerType !== "file" || !projectCwd) {
      setFileResults([]);
      return;
    }
    // 取消上一次搜索
    cancelSearchRef.current?.();
    cancelSearchRef.current = null;

    const query = trigger!.query;
    const cancel = searchFilesStream(
      query,
      { roots: [projectCwd], maxResults: 50 },
      {
        onProgress: (matches) => {
          setFileResults(matches.map(m => ({
            id: m.path,
            name: m.name,
            path: m.path.startsWith(projectCwd) ? m.path.slice(projectCwd.length + 1) : m.path,
          })));
        },
        onDone: () => {},
      },
    );
    cancelSearchRef.current = cancel;
    return () => { cancel(); };
  }, [triggerType, trigger?.query, projectCwd]);

  // $ 技能列表过滤
  const skillItems: MenuItem[] = useMemo(() => {
    if (triggerType !== "skill") return [];
    const filtered = filterItems(allSkills, trigger!.query);
    return filtered.map(s => ({
      id: s.name,
      name: s.name,
      description: s.description,
      source: s.source,
    }));
  }, [triggerType, trigger, allSkills]);

  // 当前面板列表项
  const menuItems = triggerType === "file" ? fileResults : triggerType === "skill" ? skillItems : [];

  // 面板是否打开：有触发类型且未被 Esc 关闭
  const menuOpen = triggerType !== null && !dismissed;

  // highlightedIndex 重置（触发类型或查询变化时）
  useEffect(() => {
    setHighlightedIndex(menuItems.length > 0 ? 0 : -1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerType, trigger?.query]);

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

  const handlePaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
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

  const canSend = !sendDisabled && !disabled && !!text.trim() && model !== null;

  // 选中项处理：生成 chip token 插入 text，替换末尾的触发符 + 查询文本
  const handleSelect = useCallback((item: MenuItem) => {
    const token = triggerType === "file"
      ? `@[${item.path ?? item.name}]`
      : `$[${item.name}]`;
    const triggerSymbol = triggerType === "file" ? "@" : "$";
    const query = trigger?.query ?? "";
    // 从 text 末尾去掉触发符 + 查询文本，替换为 chip token + 空格
    const triggerRe = new RegExp(
      `${triggerSymbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    );
    const newText = triggerRe.test(text)
      ? text.replace(triggerRe, token + " ")
      : text + token + " "; // fallback：直接追加
    setText(newText);
  }, [triggerType, trigger, text, setText]);

  // 键盘事件处理（面板打开时拦截导航键）
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    // 面板打开时拦截导航键
    if (menuOpen && menuItems.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightedIndex(i => (i + 1) % menuItems.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightedIndex(i => (i - 1 + menuItems.length) % menuItems.length);
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const item = menuItems[highlightedIndex];
        if (item) handleSelect(item);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // 关闭面板但保留 @/$ 文本：设 dismissed=true（text 变化时会自动重置）
        setDismissed(true);
        return;
      }
    }
    // 正常 Enter 发送
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (canSend) onSend();
    }
  }, [menuOpen, menuItems, highlightedIndex, handleSelect, canSend, onSend]);

  return (
    <div className="w-full max-w-[860px] mx-auto" data-testid="composer-input">
      <div
        className="rounded-2xl bg-surface border border-hairline shadow-md overflow-hidden focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-soft),var(--shadow-md)] transition-all duration-150"
        onDragOver={e => e.preventDefault()}
        onDrop={handleDrop}
      >
        <div className="relative">
          {menuOpen && (
            <QuickInvokeMenu
              type={triggerType!}
              items={menuItems}
              highlightedIndex={highlightedIndex}
              onSelect={handleSelect}
              onHover={setHighlightedIndex}
              emptyText={triggerType === "file" ? "无匹配文件" : "无匹配技能"}
            />
          )}
          <ComposerTextarea
            text={text}
            onTextChange={setText}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={placeholder}
            disabled={disabled}
          />
        </div>
        <div className="flex items-center justify-between px-3 py-2 border-t border-hairline">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setPickerOpen(true)}
              disabled={uploading}
              className="text-lg text-secondary hover:text-primary disabled:opacity-50"
              title="添加附件"
            >📎</button>
            <RecordButton sessionId={sessionId} projectId={projectId} />
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
