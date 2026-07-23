import { useRef, useCallback, useState, useEffect, useMemo } from "react";
import type { AttachmentDraft, ThinkingLevel } from "@hiagent/shared";
import { isModelAvailable, SUBAGENT_TYPES } from "@hiagent/shared";
import { uploadFile, copyToUploads, searchFilesStream } from "../../fs-client";
import { useProjectsStore } from "../../store/projects";
import { useProvidersStore } from "../../store/providers";
import { useSkillsStore } from "../../store/skills";
import { useAgentsStore } from "../../store/agents";
import { ModelSelector } from "./ModelSelector";
import { ThinkingSelector } from "./ThinkingSelector";
import { AttachmentChip } from "./AttachmentChip";
import { FilePicker, type FilePickerSelection } from "./FilePicker";
import { RecordButton } from "./RecordButton";
import { ComposerTextarea } from "./ComposerTextarea";
import { QuickInvokeMenu, type MenuItem } from "./QuickInvokeMenu";
import { detectTrigger, filterItems, type TriggerResult } from "../../quick-invoke/trigger";
import { registerAgentMeta } from "../../quick-invoke/tokens";

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
  /** @ 选中智能体时回调（参数为智能体 name） */
  onAgentMention?: (name: string) => void;
  /** 当前主智能体 displayName，用于过滤 @ 候选菜单（只显示其 askTo 名单内 + 排除自身） */
  currentAgentName?: string;
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
  onAgentMention, currentAgentName,
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
  const allAgents = useAgentsStore(s => s.list);

  // 检测当前 text 的触发状态
  const trigger: TriggerResult | null = useMemo(() => detectTrigger(text), [text]);

  // 触发类型
  const triggerType = trigger?.type ?? null;

  // text 变化时重置 dismissed（让面板有机会在新一次触发时再次出现）
  useEffect(() => { setDismissed(false); }, [text]);

  // 文件搜索：# 触发且有 projectCwd 时调用 searchFilesStream
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
            isDir: m.isDir,
          })));
        },
        onDone: () => {},
      },
    );
    cancelSearchRef.current = cancel;
    return () => { cancel(); };
  }, [triggerType, trigger?.query, projectCwd]);

  // @ 候选菜单无内容的根因：askTo 本身为空 vs 查询无匹配（用于 emptyText 提示文案区分）
  const agentAskToEmpty = useMemo(() => {
    if (triggerType !== "agent") return false;
    const primaryConfig = allAgents.find(a => a.displayName === currentAgentName);
    if (!primaryConfig) return false; // 当前智能体不在列表中，不算 askTo 为空
    return primaryConfig.partners.askTo.length === 0;
  }, [triggerType, allAgents, currentAgentName]);

  // @ 智能体列表过滤：只显示当前主智能体 partners.askTo 名单内 + 排除自身
  // 另追加内置 subagent 类型（general-purpose / Explore），所有主智能体都可见可 @
  const agentItems: MenuItem[] = useMemo(() => {
    if (triggerType !== "agent") return [];
    const primaryConfig = allAgents.find(a => a.displayName === currentAgentName);
    const askToSet = new Set(primaryConfig?.partners?.askTo ?? []);
    const candidates = allAgents.filter(a =>
      askToSet.has(a.displayName) && a.displayName !== currentAgentName,
    );
    const filteredNamed = filterItems(
      candidates.map(a => ({ agent: a, name: a.displayName, description: a.description })),
      trigger!.query,
    );
    const namedItems: MenuItem[] = filteredNamed.map(({ agent }) => ({
      id: agent.displayName,
      name: agent.displayName,
      description: agent.description,
      avatar: agent.avatar,
      avatarColor: agent.avatarColor,
    }));
    // 内置 subagent 类型：所有主智能体可见，按中文 displayName 模糊匹配
    // 卡片显示用中文 displayName，但 token 插入用英文 name（@[Plan]）——
    // 与 delegate 工具/提示词里的内置类型名一致，避免 LLM 把中文名误当成命名智能体
    const filteredBuiltin = filterItems(
      SUBAGENT_TYPES.map(t => ({ type: t, name: t.displayName, description: t.description })),
      trigger!.query,
    );
    const builtinItems: MenuItem[] = filteredBuiltin.map(({ type: t }) => ({
      id: t.name,            // 英文 name → 决定 token @[Plan]
      name: t.displayName,   // 中文 → 卡片显示文本
      description: t.description,
      avatar: t.emoji,
      avatarColor: `${t.gradient[0]}-${t.gradient[1]}`,
    }));
    return [...namedItems, ...builtinItems];
  }, [triggerType, trigger, allAgents, currentAgentName]);

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
  const menuItems = triggerType === "agent" ? agentItems : triggerType === "file" ? fileResults : triggerType === "skill" ? skillItems : [];

  // 面板是否打开：有触发类型且未被 Esc 关闭
  const menuOpen = triggerType !== null && !dismissed;

  // highlightedIndex 重置（触发类型或查询变化时；menuItems.length 变化覆盖异步文件结果到达场景）
  useEffect(() => {
    setHighlightedIndex(menuItems.length > 0 ? 0 : -1);
  }, [triggerType, trigger?.query, menuItems.length]);

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
        const { path } = await copyToUploads(projectId, sel.path, sessionId);
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
    const MAX_MB = 50;
    const list = Array.from(files);
    // 前端预检：超大文件直接拒绝，避免读 base64 + WS 发送后再等超时
    const oversized = list.filter(f => f.size > MAX_MB * 1024 * 1024);
    if (oversized.length > 0) {
      const names = oversized.map(f => `"${f.name}" (${(f.size / 1024 / 1024).toFixed(0)}MB)`).join("、");
      setUploadError(`附件超过 ${MAX_MB}MB 上限: ${names}`);
      return;
    }
    setUploadError(null);
    setPendingUploads(n => n + list.length);
    for (const file of list) {
      try {
        const content = await readFileAsBase64(file);
        const { path } = await uploadFile(projectId, file.name, content, sessionId);
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

  // model 必须真实存在于当前 providers 中：prefs 里可能残留已删除 provider 的过期 model，
  // 仅判"非 null"会让"未配置模型"状态下消息照样发出（后端才报错）。
  const providers = useProvidersStore(s => s.providers);
  const canSend = !sendDisabled && !disabled && !!text.trim() && isModelAvailable(model, providers);

  // 选中项处理：生成 chip token 插入 text，替换末尾的触发符 + 查询文本
  const handleSelect = useCallback((item: MenuItem) => {
    const token = triggerType === "agent"
      ? `@[${item.id}]`
      : triggerType === "file"
        ? `#[${item.path ?? item.name}]`
        : `$[${item.name}]`;
    if (triggerType === "agent") {
      // item.id 是英文 type name（内置 subagent，如 "Plan"）或 displayName（命名智能体）。
      // 对内置 subagent，item.name 是中文 displayName，传入让 chip 显示中文名而非英文 token。
      registerAgentMeta(item.id, { avatar: item.avatar, avatarColor: item.avatarColor, displayName: item.name });
    }
    const triggerSymbol = triggerType === "agent" ? "@" : triggerType === "file" ? "#" : "$";
    const query = trigger?.query ?? "";
    // 从 text 末尾去掉触发符 + 查询文本，替换为 chip token + 空格
    const triggerRe = new RegExp(
      `${triggerSymbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    );
    const newText = triggerRe.test(text)
      ? text.replace(triggerRe, token + " ")
      : text + token + " "; // fallback：直接追加
    setText(newText);
    if (triggerType === "agent") onAgentMention?.(item.id);
  }, [triggerType, trigger, text, setText, onAgentMention]);

  // 键盘事件处理（面板打开时拦截导航键）
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    // IME 组词中（拼音选词等）的按键一律不拦截、不发送：
    // 用户按 Enter 是确认候选词，不是发送消息。
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;

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
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
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
    <div className="w-full max-w-[860px] mx-auto relative" data-testid="composer-input">
      {menuOpen && (
        <QuickInvokeMenu
          type={triggerType!}
          items={menuItems}
          highlightedIndex={highlightedIndex}
          onSelect={handleSelect}
          onHover={setHighlightedIndex}
          emptyText={triggerType === "agent" ? (agentAskToEmpty ? "当前智能体无可调起的子智能体，请在智能体配置中设置关系网" : "无匹配智能体") : triggerType === "file" ? "无匹配文件" : "无匹配技能"}
        />
      )}
      <div
        className="rounded-2xl bg-surface border border-hairline shadow-md overflow-hidden focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-soft),var(--shadow-md)] transition-all duration-150"
        onDragOver={e => e.preventDefault()}
        onDrop={handleDrop}
      >
        <ComposerTextarea
          text={text}
          onTextChange={setText}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={placeholder}
          disabled={disabled}
        />
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
