import { useState } from "react";
import type { AgentName } from "@hiagent/shared";
import { send } from "../ws-instance";
import { useProjectsStore } from "../store/projects";
import { agentEmoji } from "../theme/agents";

interface Props {
  sessionId: string;
  agentName: AgentName;
}

export function Composer({ sessionId, agentName }: Props) {
  const [text, setText] = useState("");
  const { sessions, currentProjectId } = useProjectsStore();
  const session = sessions.find(s => s.id === sessionId);
  const projectId = session?.projectId ?? currentProjectId ?? "";

  const handleSend = () => {
    if (!text.trim()) return;
    send({ type: "agent:prompt", projectId, sessionId, agentName, text });
    setText("");
  };

  return (
    <div className="p-3" style={{ background: "#181825" }} data-testid="composer">
      <div className="flex gap-2 items-end rounded-lg p-2" style={{ background: "#313244" }}>
        <span className="text-lg">{agentEmoji(agentName)}</span>
        <textarea
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder={`给${agentName}发消息...`}
          className="flex-1 bg-transparent text-text outline-none resize-none text-sm"
          rows={1}
          data-testid="composer-input"
        />
        <button
          onClick={handleSend}
          disabled={!text.trim()}
          className="px-3 py-1 rounded text-sm"
          style={{ background: text.trim() ? "#89b4fa" : "#585b70", color: "#1e1e2e" }}
          data-testid="composer-send"
        >↩</button>
      </div>
    </div>
  );
}
