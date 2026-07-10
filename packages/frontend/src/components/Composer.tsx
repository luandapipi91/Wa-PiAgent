import { useState, useRef, useEffect } from "react";
import type { AgentName, AttachmentDraft } from "@hiagent/shared";
import { send } from "../ws-instance";
import { useProjectsStore } from "../store/projects";
import { useComposerPrefsStore } from "../store/composer-prefs";
import { ComposerInput } from "./ui/ComposerInput";

interface Props {
  sessionId: string;
  agentName: AgentName;
  isRunning?: boolean;
}

export function Composer({ sessionId, agentName, isRunning }: Props) {
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

  const handleSend = () => {
    if (!text.trim() || !model || sendingRef.current || !projectId) return;
    sendingRef.current = true;
    send({
      type: "agent:prompt",
      projectId,
      sessionId,
      agentName,
      text,
      model,
      thinking,
      attachments: attachments.length > 0 ? attachments : undefined,
    });
    setText("");
    setSessionPrefs(sessionId, { attachments: [] });
    setTimeout(() => { sendingRef.current = false; }, 500);
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
        setAttachments={ats => setSessionPrefs(sessionId, { attachments: ats })}
        onSend={handleSend}
        sendDisabled={!projectId || isRunning}
        placeholder={isRunning ? "输入要加入队列的消息..." : `给${agentName}发消息...`}
      />
    </div>
  );
}
