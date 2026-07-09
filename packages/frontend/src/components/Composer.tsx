import { useState, useRef, useEffect, useCallback } from "react";
import type { AgentName } from "@hiagent/shared";
import { send } from "../ws-instance";
import { useProjectsStore } from "../store/projects";
import { agentEmoji } from "../theme/agents";

interface Props {
  sessionId: string;
  agentName: AgentName;
  isRunning?: boolean;
}

export function Composer({ sessionId, agentName, isRunning }: Props) {
  const [text, setText] = useState("");
  const sendingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { sessions, currentProjectId } = useProjectsStore();
  const session = sessions.find(s => s.id === sessionId);
  const projectId = session?.projectId ?? currentProjectId ?? "";

  // 自动调整高度：最低1行，最高300px
  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 300) + "px";
  }, []);

  useEffect(() => { autoResize(); }, [text, autoResize]);

  const handleSend = () => {
    if (!text.trim() || sendingRef.current) return;
    sendingRef.current = true;
    send({ type: "agent:prompt", projectId, sessionId, agentName, text });
    setText("");
    setTimeout(() => { sendingRef.current = false; }, 500);
  };

  return (
    <div className="px-6 py-3 pb-5" data-testid="composer">
      <div className="flex gap-2.5 items-end rounded-lg p-1 pl-3.5 bg-surface border border-hairline shadow-md max-w-[860px] mx-auto transition-all duration-150 focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--accent-soft),var(--shadow-md)]">
        <span className="text-lg pb-0.5">{agentEmoji(agentName)}</span>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder={isRunning ? "输入要加入队列的消息..." : `给${agentName}发消息...`}
          className="flex-1 bg-transparent text-primary outline-none resize-none text-sm py-2.5 placeholder:text-tertiary"
          rows={1}
          style={{ maxHeight: 300, overflowY: "auto" }}
          data-testid="composer-input"
        />
        <span className="text-[11px] text-tertiary cursor-pointer hover:text-secondary transition-colors whitespace-nowrap select-none">🎨 模型</span>
        <button
          onClick={handleSend}
          disabled={!text.trim()}
          className="w-9 h-9 rounded-sm flex items-center justify-center text-base flex-shrink-0 transition-transform enabled:hover:scale-105 border-0 cursor-pointer disabled:cursor-not-allowed"
          style={{
            background: text.trim() ? "var(--brand)" : "var(--hairline-strong)",
            color: "var(--on-brand)",
          }}
          data-testid="composer-send"
        >{isRunning ? "↑" : "↩"}</button>
      </div>
    </div>
  );
}
