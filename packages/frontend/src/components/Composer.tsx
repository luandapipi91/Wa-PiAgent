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
    <div className="p-3" style={{ background: "#181825" }} data-testid="composer">
      <div className="flex gap-2 items-end rounded-lg p-2" style={{ background: "#313244" }}>
        <span className="text-lg">{agentEmoji(agentName)}</span>
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
          className="flex-1 bg-transparent text-text outline-none resize-none text-sm"
          rows={1}
          style={{ maxHeight: 300, overflowY: "auto" }}
          data-testid="composer-input"
        />
        <button
          onClick={handleSend}
          disabled={!text.trim()}
          className="px-3 py-1 rounded text-sm"
          style={{ background: text.trim() ? "#89b4fa" : "#585b70", color: "#1e1e2e" }}
          data-testid="composer-send"
        >{isRunning ? "↑" : "↩"}</button>
      </div>
    </div>
  );
}
