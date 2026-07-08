import { useState, useRef, useEffect, useCallback } from "react";
import { AGENT_DEFS, randomSessionId } from "@hiagent/shared";
import type { AgentName } from "@hiagent/shared";
import { useProjectsStore } from "../store/projects";
import { send } from "../ws-instance";

const NAMES: AgentName[] = ["product", "pm", "dev", "test"];

export function NewSessionPane() {
  const { projects, currentProjectId } = useProjectsStore();
  const [agentName, setAgentName] = useState<AgentName>("dev");
  const [text, setText] = useState("");
  const initialProject = currentProjectId ?? projects[0]?.id ?? null;
  const [projectId, setProjectId] = useState<string | null>(initialProject);
  // currentProjectId 变化时同步（点项目旁 + 号时可能已在新建页，不会重新挂载）
  useEffect(() => { if (currentProjectId) setProjectId(currentProjectId); }, [currentProjectId]);
  // 会话 ID 只生成一次并复用，避免快速连发多条消息创建多个重复 session
  const [sessionId] = useState(() => randomSessionId());
  const sendingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const autoResize = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 300) + "px";
  }, []);

  useEffect(() => { autoResize(); }, [text, autoResize]);

  const handleSend = () => {
    if (!projectId || !text.trim() || sendingRef.current) return;
    sendingRef.current = true;
    send({ type: "agent:prompt", projectId, sessionId, agentName, text });
    setText("");
    setTimeout(() => { sendingRef.current = false; }, 500);
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-6" data-testid="new-session-pane">
      <h2 className="text-2xl font-bold text-text mb-2">开始新会话</h2>
      <p className="text-subtext mb-6">选好项目目录和角色，直接打字发送</p>
      <div className="w-full max-w-2xl bg-surface rounded-lg overflow-hidden" style={{ background: "#313244" }}>
        <div className="flex gap-2 p-2 border-b border-surface2">
          <select
            value={projectId ?? ""}
            onChange={e => setProjectId(e.target.value || null)}
            className="flex-1 bg-mantle text-text rounded px-2 py-1 text-sm"
            data-testid="project-select"
          >
            {projects.length === 0 && <option value="">（无项目，请先新建）</option>}
            {projects.map(p => <option key={p.id} value={p.id}>📁 {p.name} {p.cwd}</option>)}
          </select>
          <select
            value={agentName}
            onChange={e => setAgentName(e.target.value as AgentName)}
            className="bg-mantle text-text rounded px-2 py-1 text-sm"
            data-testid="agent-select"
          >
            {NAMES.map(n => <option key={n} value={n}>{AGENT_DEFS[n].emoji} {AGENT_DEFS[n].label}</option>)}
          </select>
        </div>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } }}
          placeholder="给研发发消息..."
          className="w-full bg-transparent text-text p-3 outline-none resize-none"
          rows={1}
          style={{ maxHeight: 300, overflowY: "auto" }}
          data-testid="new-session-input"
        />
        <div className="flex items-center justify-between p-2 border-t border-surface2">
          <span className="text-xs text-overlay">📎 附件 🎨 模型</span>
          <button
            onClick={handleSend}
            disabled={!projectId || !text.trim()}
            className="px-3 py-1 rounded text-sm"
            style={{ background: text.trim() && projectId ? "#89b4fa" : "#585b70", color: "#1e1e2e" }}
            data-testid="new-session-send"
          >发送 →</button>
        </div>
      </div>
      <p className="text-xs text-overlay mt-4">💡 项目目录可在此切换；agent 选谁谁是主理人</p>
    </div>
  );
}
