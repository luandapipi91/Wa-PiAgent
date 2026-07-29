import { useState, useRef, useEffect } from "react";
import type { AgentName, AttachmentDraft, ThinkingLevel } from "@wa-pi/shared";
import { isModelAvailable } from "@wa-pi/shared";
import { api } from "../api-client";
import { useProjectsStore } from "../store/projects";
import { useProvidersStore } from "../store/providers";
import { useComposerPrefsStore } from "../store/composer-prefs";
import { useSessionStore } from "../store/session";
import { expandTokens } from "../quick-invoke/tokens";
import { ComposerInput } from "./ui/ComposerInput";

interface Props {
  sessionId: string;
  agentName: AgentName;
  isRunning?: boolean;
  isNewSession?: boolean;
  disabled?: boolean;
}

export function Composer({ sessionId, agentName, isRunning, isNewSession, disabled }: Props) {
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
  const providers = useProvidersStore(s => s.providers);

  const doSend = (targetAgent: AgentName, expandedText: string) => {
    sendingRef.current = true;
    // 空闲时：乐观 UI 立即显示用户消息 + AI loading，不等 SDK 回声。
    // 运行中：消息发给 kernel 入队（followUp），立即显示在顶部队列面板。
    if (!isRunning) {
      useSessionStore.getState().optimisticSend(sessionId, expandedText, targetAgent);
    } else {
      // 乐观追加到排队列表，同时标记 optimisticEcho 防止 kernel 的 session:echo_user
      // 把 followUp 消息重复注入到会话列表（echo_user 会对每条 prompt 回传）
      useSessionStore.setState(s => {
        const cur = s.queueBySession[sessionId];
        return {
          queueBySession: { ...s.queueBySession, [sessionId]: { steering: cur?.steering ?? [], followUp: cur ? [...cur.followUp, expandedText] : [expandedText] } },
          optimisticEchoBySession: { ...s.optimisticEchoBySession, [sessionId]: true },
        };
      });
    }
    api.post(`/api/agents/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}/prompt`, {
      agentName: targetAgent,
      text: expandedText,
      model: model!,
      thinking,
      attachments: attachments.length > 0 ? attachments : undefined,
    }).catch(err => {
      console.error("[composer] 发送失败:", err);
      useSessionStore.getState().failTurn(sessionId);
    });
    setText("");
    setSessionPrefs(sessionId, { attachments: [] });
    setTimeout(() => { sendingRef.current = false; }, 500);
  };

  const handleSend = () => {
    if (disabled) return;
    // @[xxx] 不剥离，原样保留给主智能体识别（由 WA_PI_DEFAULT_SYSTEM_PROMPT 中的规则触发 delegate）
    const expandedText = expandTokens(text);
    if (!expandedText.trim() || !isModelAvailable(model, providers) || sendingRef.current || !projectId) return;
    doSend(agentName, expandedText);
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
        isRunning={isRunning}
        isNewSession={isNewSession}
        currentAgentName={agentName}
      />
    </div>
  );
}
