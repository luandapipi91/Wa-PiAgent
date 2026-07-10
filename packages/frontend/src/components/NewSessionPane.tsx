import { useState, useRef, useEffect } from "react";
import { AGENT_DEFS, randomSessionId } from "@hiagent/shared";
import type { AgentName, AttachmentDraft, ThinkingLevel } from "@hiagent/shared";
import { useProjectsStore } from "../store/projects";
import { useComposerPrefsStore } from "../store/composer-prefs";
import { send } from "../ws-instance";
import { ComposerInput } from "./ui/ComposerInput";

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

  const defaults = useComposerPrefsStore(s => s.defaults);
  const setDefaults = useComposerPrefsStore(s => s.setDefaults);
  const loadDefaults = useComposerPrefsStore(s => s.loadDefaults);

  useEffect(() => { void loadDefaults(); }, [loadDefaults]);

  const [model, setModel] = useState<string | null>(defaults.model);
  const [thinking, setThinking] = useState<ThinkingLevel>(defaults.thinking);
  const [attachments, setAttachments] = useState<AttachmentDraft[]>([]);

  useEffect(() => {
    setModel(defaults.model);
    setThinking(defaults.thinking);
  }, [defaults.model, defaults.thinking]);

  const handleSend = () => {
    if (!projectId || !text.trim() || !model || sendingRef.current) return;
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
    setAttachments([]);
    setDefaults({ model, thinking });
    setTimeout(() => { sendingRef.current = false; }, 500);
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center p-10" data-testid="new-session-pane">
      <h2 className="text-[26px] font-extrabold tracking-tight text-primary mb-2">开始新会话</h2>
      <p className="text-sm text-secondary mb-7">选好项目目录和角色，直接打字发送</p>
      <div className="w-full max-w-2xl mb-4 flex gap-2">
        <select
          value={projectId ?? ""}
          onChange={e => setProjectId(e.target.value || null)}
          className="flex-1 bg-surface border border-hairline rounded-sm text-primary px-2.5 py-1.5 text-[12.5px]"
          data-testid="project-select"
        >
          {projects.length === 0 && <option value="">（无项目，请先新建）</option>}
          {projects.map(p => <option key={p.id} value={p.id}>📁 {p.name} {p.cwd}</option>)}
        </select>
        <select
          value={agentName}
          onChange={e => setAgentName(e.target.value as AgentName)}
          className="bg-surface border border-hairline rounded-sm text-primary px-2.5 py-1.5 text-[12.5px]"
          data-testid="agent-select"
        >
          {NAMES.map(n => <option key={n} value={n}>{AGENT_DEFS[n].emoji} {AGENT_DEFS[n].label}</option>)}
        </select>
      </div>
      <ComposerInput
        text={text}
        setText={setText}
        model={model}
        setModel={m => { setModel(m); setDefaults({ model: m }); }}
        thinking={thinking}
        setThinking={t => { setThinking(t); setDefaults({ thinking: t }); }}
        attachments={attachments}
        setAttachments={setAttachments}
        projectId={projectId ?? undefined}
        onSend={handleSend}
        sendDisabled={!projectId}
        placeholder="给研发发消息..."
      />
      <p className="text-[11.5px] text-tertiary mt-4">💡 项目目录可在此切换；agent 选谁谁是主理人</p>
    </div>
  );
}
