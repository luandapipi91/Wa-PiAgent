import { useState, useRef, useEffect } from "react";
import type { AgentName, AttachmentDraft, ThinkingLevel } from "@hiagent/shared";
import { isModelAvailable } from "@hiagent/shared";
import { send } from "../ws-instance";
import { useProjectsStore } from "../store/projects";
import { useProvidersStore } from "../store/providers";
import { useComposerPrefsStore } from "../store/composer-prefs";
import { useSessionStore } from "../store/session";
import { expandTokens, extractAgentToken } from "../quick-invoke/tokens";
import { ComposerInput } from "./ui/ComposerInput";
import { Modal } from "./ui/Modal";

interface Props {
  sessionId: string;
  agentName: AgentName;
  isRunning?: boolean;
  disabled?: boolean;
}

export function Composer({ sessionId, agentName, isRunning, disabled }: Props) {
  const [text, setText] = useState("");
  const sendingRef = useRef(false);
  const { sessions, currentProjectId } = useProjectsStore();
  const session = sessions.find(s => s.id === sessionId);
  const projectId = session?.projectId ?? currentProjectId ?? "";

  const prefs = useComposerPrefsStore(s => s.bySession[sessionId]);
  const setSessionPrefs = useComposerPrefsStore(s => s.setSessionPrefs);
  const loadSession = useComposerPrefsStore(s => s.loadSession);

  useEffect(() => { void loadSession(sessionId); }, [sessionId, loadSession]);

  const model = prefs?.model ?? null;
  const thinking = prefs?.thinking ?? "disabled";
  const attachments = prefs?.attachments ?? [];
  // 待确认的 @提及切换：非 null 时显示缓存失效确认框
  const [pendingMention, setPendingMention] = useState<{ mention: AgentName; text: string } | null>(null);
  const providers = useProvidersStore(s => s.providers);

  const doSend = (targetAgent: AgentName, expandedText: string) => {
    sendingRef.current = true;
    // 空闲时：乐观 UI 立即显示用户消息 + AI loading，不等 SDK 回声。
    // 运行中：消息发给 kernel 入队（followUp），立即显示在顶部队列面板。
    if (!isRunning) {
      useSessionStore.getState().optimisticSend(sessionId, expandedText, targetAgent);
    } else {
      useSessionStore.getState().appendLocalFollowUp(sessionId, expandedText);
    }
    send({
      type: "agent:prompt",
      projectId,
      sessionId,
      agentName: targetAgent,
      text: expandedText,
      model: model!,
      thinking,
      attachments: attachments.length > 0 ? attachments : undefined,
    });
    setText("");
    setSessionPrefs(sessionId, { attachments: [] });
    setTimeout(() => { sendingRef.current = false; }, 500);
  };

  const handleSend = () => {
    if (disabled) return;
    // 先剥离 @智能体 提及（@[名称] 不参与 expandTokens 展开）
    const { agent: mention, rest } = extractAgentToken(text);
    // 展开 chip token 为纯文本引用标记（#[path] -> #path，$[name] -> /skill:name）
    const expandedText = expandTokens(mention ? rest : text);
    if (!expandedText.trim() || !isModelAvailable(model, providers) || sendingRef.current || !projectId) return;
    // @提及其他智能体：先弹缓存失效确认框
    if (mention && mention !== agentName) {
      setPendingMention({ mention: mention as AgentName, text: expandedText });
      return;
    }
    doSend(agentName, expandedText);
  };

  const handleMentionConfirm = () => {
    if (!pendingMention) return;
    const { mention, text: expandedText } = pendingMention;
    setPendingMention(null);
    // 先切换会话主智能体，再用 mention 发送
    send({ type: "session:set-agent", sessionId, agentName: mention });
    doSend(mention, expandedText);
  };

  return (
    <div className="px-6 py-3 pb-5" data-testid="composer">
      <ComposerInput
        text={text}
        setText={setText}
        model={model}
        setModel={m => setSessionPrefs(sessionId, { model: m })}
        thinking={thinking}
        setThinking={t => setSessionPrefs(sessionId, { thinking: t })}
        attachments={attachments}
        setAttachments={updater => {
          const current = useComposerPrefsStore.getState().bySession[sessionId]?.attachments ?? [];
          const next = typeof updater === "function" ? (updater as (prev: AttachmentDraft[]) => AttachmentDraft[])(current) : updater;
          setSessionPrefs(sessionId, { attachments: next });
        }}
        projectId={projectId}
        sessionId={sessionId}
        onSend={handleSend}
        sendDisabled={!projectId}
        disabled={disabled}
        placeholder={disabled ? "请先回答上方提问…" : (isRunning ? "输入要加入队列的消息..." : `给${agentName}发消息...`)}
      />
      {/* @提及其他智能体的缓存失效确认框（样式同 AgentSwitcher） */}
      {pendingMention && (
        <Modal onClose={() => setPendingMention(null)} width={400} data-testid="mention-confirm">
          <div className="p-4 border-b border-hairline">
            <div className="text-primary font-bold text-sm">切换智能体</div>
          </div>
          <div className="p-4 text-sm text-secondary leading-relaxed">切换智能体后所有缓存都会失效，是否继续？</div>
          <div className="flex justify-end gap-2 p-3 border-t border-hairline">
            <button
              onClick={() => setPendingMention(null)}
              className="px-3 py-1.5 rounded-sm text-sm bg-surface-hover text-secondary border border-hairline transition-colors hover:text-primary"
              data-testid="mention-confirm-cancel"
            >取消</button>
            <button
              onClick={handleMentionConfirm}
              className="px-3 py-1.5 rounded-sm text-sm border-0 cursor-pointer"
              style={{ background: "var(--brand)", color: "var(--on-brand)" }}
              data-testid="mention-confirm-ok"
            >继续切换</button>
          </div>
        </Modal>
      )}
    </div>
  );
}
