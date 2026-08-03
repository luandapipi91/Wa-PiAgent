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
  // === 草稿持久化 ===
  const draftRestoredRef = useRef(false); // 当前 session 是否已尝试恢复草稿（按 sessionId 重置）
  const textRef = useRef("");             // 始终同步最新 text，供 cleanup flush
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevSessionIdRef = useRef(sessionId);
  const sendingRef = useRef(false);
  const { sessions, currentProjectId } = useProjectsStore();
  const session = sessions.find(s => s.id === sessionId);
  const projectId = session?.projectId ?? currentProjectId ?? "";

  const prefs = useComposerPrefsStore(s => s.bySession[sessionId]);
  const setSessionPrefs = useComposerPrefsStore(s => s.setSessionPrefs);
  const loadSession = useComposerPrefsStore(s => s.loadSession);
  // 会话 prefs 冷加载完成前禁止 auto-select：间隙内 model=null 会触发 ModelSelector
  // 自动选第一个模型并写进 prefs/defaults（"切几个会话后模型被重置为第一个"的根因）
  const prefsLoaded = useComposerPrefsStore(s => !!s.loadedBySession[sessionId]);

  const draftText = prefs?.text;

  // 渲染期：sessionId 变化 → 立即清空输入框（消除旧会话文本残留一帧）+ 重置恢复标记
  if (prevSessionIdRef.current !== sessionId) {
    prevSessionIdRef.current = sessionId;
    draftRestoredRef.current = false;
    setText("");
  }
  // textRef 始终同步最新 text
  useEffect(() => { textRef.current = text; }, [text]);

  // 草稿恢复：prefs 加载完成且有草稿时恢复一次（draftRestoredRef 防止恢复后又被覆盖）
  useEffect(() => {
    if (!draftRestoredRef.current && prefsLoaded) {
      draftRestoredRef.current = true;
      if (draftText) setText(draftText);
    }
  }, [prefsLoaded, draftText, sessionId]);

  // 防抖写回：输入变化 300ms 后持久化（含清空 → 写空串 = 放弃草稿）
  const handleTextChange = (next: string) => {
    setText(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      setSessionPrefs(sessionId, { text: next });
    }, 300);
  };

  // 切走/卸载前 flush：把防抖未触发的最后文本写回（闭包捕获当前 sessionId）
  useEffect(() => {
    const mySessionId = sessionId;
    return () => {
      if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
      setSessionPrefs(mySessionId, { text: textRef.current });
    };
  }, [sessionId, setSessionPrefs]);

  useEffect(() => { void loadSession(sessionId); }, [sessionId, loadSession]);

  const model = prefs?.model ?? null;
  // thinking 未显式设置时回退到全局 defaults（而非硬编码 disabled）
  const defaults = useComposerPrefsStore(s => s.defaults);
  const thinking = prefs?.thinking ?? defaults.thinking;
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
    if (debounceRef.current) { clearTimeout(debounceRef.current); debounceRef.current = null; }
    setText("");
    setSessionPrefs(sessionId, { text: "" });
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
        setText={handleTextChange}
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
        modelAutoSelectEnabled={prefsLoaded}
      />
    </div>
  );
}
