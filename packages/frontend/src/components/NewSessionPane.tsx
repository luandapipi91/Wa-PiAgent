import { useState, useRef, useEffect } from "react";
import { isModelAvailable, randomSessionId, SYSTEM_PROJECT_ID } from "@wa-pi/shared";
import type { AgentName, AttachmentDraft, ThinkingLevel } from "@wa-pi/shared";
import { useProjectsStore } from "../store/projects";
import { useAgentsStore, topAgentsByRecency } from "../store/agents";
import { useProvidersStore } from "../store/providers";
import { useComposerPrefsStore } from "../store/composer-prefs";
import { api } from "../api-client";
import { expandTokens } from "../quick-invoke/tokens";
import { ComposerInput } from "./ui/ComposerInput";
import { AgentDropdown } from "./ui/AgentDropdown";

interface Props {
  /** 侧栏/宫格「新建会话」带过来的预选智能体；为空则取最近使用的智能体 */
  pendingAgent?: string | null;
  /** pendingAgent 已被取用为初始值后回调一次（App 侧清除，避免下次进新建页又预选旧值） */
  onConsumePendingAgent?: () => void;
}

/** 计算新建会话的默认智能体：pendingAgent 优先 → 最近使用者 → 列表第一项 */
function pickDefaultAgent(
  agents: ReturnType<typeof useAgentsStore.getState>["list"],
  sessions: ReturnType<typeof useProjectsStore.getState>["sessions"],
  pendingAgent?: string | null,
): AgentName | null {
  if (pendingAgent) return pendingAgent as AgentName;
  if (sessions.length > 0) {
    const r = topAgentsByRecency(agents, sessions, 1)[0]?.displayName;
    if (r) return r;
  }
  return agents[0]?.displayName ?? null;
}

export function NewSessionPane({ pendingAgent = null, onConsumePendingAgent }: Props) {
  const { projects, currentProjectId, sessions } = useProjectsStore();
  const agents = useAgentsStore(s => s.list);
  // 默认选中最近使用的智能体（pendingAgent 优先）；空列表时为 null（发送前置条件拦截）
  const [agentName, setAgentName] = useState<AgentName | null>(pickDefaultAgent(agents, sessions, pendingAgent));
  const [text, setText] = useState("");
  const initialProject =
    currentProjectId
    ?? projects.find(p => p.id === SYSTEM_PROJECT_ID)?.id
    ?? projects[0]?.id
    ?? null;
  const [projectId, setProjectId] = useState<string | null>(initialProject);
  // currentProjectId 变化时同步（点项目旁 + 号时可能已在新建页，不会重新挂载）
  useEffect(() => { if (currentProjectId) setProjectId(currentProjectId); }, [currentProjectId]);
  // pendingAgent 变化时同步（已停在新建页再点侧栏/宫格智能体，组件不会重新挂载）
  useEffect(() => { if (pendingAgent) setAgentName(pendingAgent as AgentName); }, [pendingAgent]);
  // 首载 agent:list 回包晚于挂载：list 空转非空且 agentName 仍为 null 时回填（沿用 pendingAgent 优先级 + recency）；已选中则不干预
  useEffect(() => {
    if (!agentName && agents.length > 0) setAgentName(pickDefaultAgent(agents, sessions, pendingAgent));
  }, [agents, agentName, pendingAgent, sessions]);
  // 挂载消费一次：初始值取用后通知 App 清除 pendingAgent（空依赖，仅首次挂载）
  useEffect(() => { if (pendingAgent) onConsumePendingAgent?.(); }, []);
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
  const providers = useProvidersStore(s => s.providers);
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
    // model 必须是当前 providers 中真实存在的模型（prefs 可能残留已删除 provider 的过期 model）
    if (!projectId || !text.trim() || !isModelAvailable(model, providers) || !agentName || sendingRef.current) return;
    sendingRef.current = true;
    // newSessionIds 可能残留一个已发送过的会话 id（session:created 未及时清除 / app 重启后从 IndexedDB 读出），
    // 复用会导致 addSession 去重 no-op、selectSession 跳回那个旧会话（「跳到上一个会话」bug）。
    // 这里检测到 sessionId 已被占用时，生成全新 id 并回填 newSessionIds，确保每次发送都是新会话。
    const existed = useProjectsStore.getState().sessions.some(s => s.id === sessionId);
    const finalId = existed ? randomSessionId() : sessionId;
    if (existed && projectId) setNewSessionId(projectId, finalId);
    // primaryAgent = 顶部 dropdown 选中的 agentName（不变）
    // @[xxx] 原样发给主智能体，由 systemPrompt 规则触发 delegate
    const expandedText = expandTokens(text);
    // 乐观 UI：立即创建会话触发导航，消除白屏等待。
    // 用户消息由 kernel session:echo_user 回传后 App.tsx 调 optimisticSend 秒显示。
    // kernel _promptLocks 串行锁防并发竞态。
    useProjectsStore.getState().addSession({
      id: finalId,
      projectId,
      primaryAgent: agentName,
      title: expandedText.slice(0, 20),
      createdAt: Date.now(),
      lastActivity: Date.now(),
      piSessionFile: "",
    });
    // 确保导航到目标会话（addSession 遇去重时会 no-op，currentSessionId 需显式设置）
    useProjectsStore.getState().selectSession(finalId);
    void api.post(`/api/agents/${encodeURIComponent(projectId)}/${encodeURIComponent(finalId)}/prompt`, {
      agentName,
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
      <div className="w-full max-w-2xl mb-4 flex gap-2 items-center">
        <select
          value={projectId ?? ""}
          onChange={e => setProjectId(e.target.value || null)}
          className="flex-1 bg-surface border border-hairline rounded-sm text-primary px-2.5 py-1.5 text-[12.5px]"
          data-testid="project-select"
        >
          {projects.length === 0 && <option value="">（无项目，请先新建）</option>}
          {projects.map(p => (
            <option key={p.id} value={p.id}>
              {p.id === SYSTEM_PROJECT_ID ? "🏠 " : "📁 "}{p.name}
              {p.id === SYSTEM_PROJECT_ID ? "" : ` ${p.cwd}`}
            </option>
          ))}
        </select>
        <AgentDropdown
          agents={agents}
          value={agentName}
          onPick={name => setAgentName(name)}
        />
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
        sendDisabled={!projectId || !agentName}
        placeholder="给研发发消息..."
        currentAgentName={agentName ?? undefined}
        isRunning={false}
        isNewSession={true}
      />
    </div>
  );
}
