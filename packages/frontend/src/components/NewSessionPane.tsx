import { useState, useRef, useEffect } from "react";
import { agentDefOf, randomSessionId } from "@hiagent/shared";
import type { AgentName, AttachmentDraft, ThinkingLevel } from "@hiagent/shared";
import { useProjectsStore } from "../store/projects";
import { useAgentsStore } from "../store/agents";
import { useComposerPrefsStore } from "../store/composer-prefs";
import { send } from "../ws-instance";
import { expandTokens, extractAgentToken } from "../quick-invoke/tokens";
import { ComposerInput } from "./ui/ComposerInput";

interface Props {
  /** 侧栏/宫格「新建会话」带过来的预选智能体；为空则取列表第一项 */
  pendingAgent?: string | null;
}

export function NewSessionPane({ pendingAgent = null }: Props) {
  const { projects, currentProjectId } = useProjectsStore();
  const agents = useAgentsStore(s => s.list);
  const [agentName, setAgentName] = useState<AgentName>(pendingAgent ?? agents[0]?.name ?? "dev");
  const [text, setText] = useState("");
  const initialProject = currentProjectId ?? projects[0]?.id ?? null;
  const [projectId, setProjectId] = useState<string | null>(initialProject);
  // currentProjectId 变化时同步（点项目旁 + 号时可能已在新建页，不会重新挂载）
  useEffect(() => { if (currentProjectId) setProjectId(currentProjectId); }, [currentProjectId]);
  // pendingAgent 变化时同步（已停在新建页再点侧栏/宫格智能体，组件不会重新挂载）
  useEffect(() => { if (pendingAgent) setAgentName(pendingAgent); }, [pendingAgent]);
  // 新建会话的 sessionId 按当前项目持久化，切换再回来仍能对应同一组 composer 附件/录音
  const newSessionKey = projectId ?? "__global__";
  const newSessionIds = useComposerPrefsStore(s => s.newSessionIds);
  const setNewSessionId = useComposerPrefsStore(s => s.setNewSessionId);
  const [sessionId, setSessionId] = useState(() => newSessionIds[newSessionKey] ?? randomSessionId());
  const sendingRef = useRef(false);

  useEffect(() => {
    const stored = newSessionIds[newSessionKey];
    if (stored && stored !== sessionId) {
      setSessionId(stored);
    } else if (!stored) {
      const fresh = randomSessionId();
      setSessionId(fresh);
      setNewSessionId(newSessionKey, fresh);
    }
  }, [newSessionKey, newSessionIds[newSessionKey], setNewSessionId, sessionId]);

  const defaults = useComposerPrefsStore(s => s.defaults);
  const setDefaults = useComposerPrefsStore(s => s.setDefaults);
  const loadDefaults = useComposerPrefsStore(s => s.loadDefaults);

  useEffect(() => { void loadDefaults(); }, [loadDefaults]);

  const [model, setModel] = useState<string | null>(defaults.model);
  const [thinking, setThinking] = useState<ThinkingLevel>(defaults.thinking);
  const prefs = useComposerPrefsStore(s => s.bySession[sessionId]);
  const attachments = prefs?.attachments ?? [];
  const setAttachments = (next: AttachmentDraft[] | ((prev: AttachmentDraft[]) => AttachmentDraft[])) => {
    const resolved = typeof next === "function" ? next(attachments) : next;
    useComposerPrefsStore.getState().setSessionPrefs(sessionId, { attachments: resolved });
  };

  useEffect(() => {
    setModel(defaults.model);
    setThinking(defaults.thinking);
  }, [defaults.model, defaults.thinking]);

  const handleSend = () => {
    if (!projectId || !text.trim() || !model || sendingRef.current) return;
    sendingRef.current = true;
    // @提及智能体：新会话无缓存可失效，直接以 mention 为主智能体，无需确认框
    const { agent: mention, rest } = extractAgentToken(text);
    const targetAgent = (mention as AgentName | null) ?? agentName;
    if (mention) setAgentName(mention as AgentName);
    // 展开 chip token 为纯文本引用标记（$[name] -> /skill:name，#[path] -> #path）
    const expandedText = expandTokens(mention ? rest : text);
    // 乐观 UI：立即创建会话触发导航，消除白屏等待。
    // 用户消息由 kernel session:echo_user 回传后 App.tsx 调 optimisticSend 秒显示。
    // kernel _promptLocks 串行锁防并发竞态。
    useProjectsStore.getState().addSession({
      id: sessionId,
      projectId,
      primaryAgent: targetAgent,
      title: expandedText.slice(0, 20),
      createdAt: Date.now(),
      lastActivity: Date.now(),
      piSessionFile: "",
    });
    send({
      type: "agent:prompt",
      projectId,
      sessionId,
      agentName: targetAgent,
      text: expandedText,
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
          disabled={agents.length === 0}
          className="bg-surface border border-hairline rounded-sm text-primary px-2.5 py-1.5 text-[12.5px]"
          data-testid="agent-select"
        >
          {agents.length === 0 && <option value="">（无智能体）</option>}
          {agents.map(a => {
            const def = agentDefOf(a.name);
            return <option key={a.name} value={a.name}>{def.emoji} {a.displayName || def.label}</option>;
          })}
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
        sessionId={sessionId}
        onSend={handleSend}
        sendDisabled={!projectId}
        placeholder="给研发发消息..."
        onAgentMention={name => setAgentName(name as AgentName)}
      />
    </div>
  );
}
